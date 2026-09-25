import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  type AgentServerMessage,
} from "../src/proto/agent_pb.js";
import { frameConnectMessage } from "../src/client/bridge.js";
import { __testInternals } from "../src/stream/native-core.js";
import { destroyAllIdleBridges, setBridgeFactoryForTests } from "../src/stream/bridge-session.js";
import {
  cleanupAllSessionState,
  conversationStates,
  deriveConversationKeyFromSessionId,
  fingerprintCompletedTurns,
} from "../src/stream/session-state.js";
import * as requestBuild from "../src/stream/request-build.js";
import type { RootPromptMessage } from "../src/stream/root-prompt.js";
import type { ChatCompletionRequest, NativeStreamWriter } from "../src/stream/types.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";

function fakeBridge() {
  let onData = (_chunk: Buffer) => {};
  let onClose = (_code: number) => {};
  return {
    alive: true,
    proc: { kill: () => true },
    lastStderr: () => "ECONNRESET",
    write: vi.fn(),
    end() {
      this.alive = false;
    },
    onData(callback: typeof onData) {
      onData = callback;
    },
    onClose(callback: typeof onClose) {
      onClose = callback;
    },
    receive(message: AgentServerMessage["message"]) {
      onData(
        Buffer.from(
          frameConnectMessage(
            toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })),
          ),
        ),
      );
    },
    close(code: number) {
      this.alive = false;
      onClose(code);
    },
  };
}

const sessionId = "recovery-prompt-test";
const convKey = deriveConversationKeyFromSessionId(sessionId);
const checkpoint = create(ConversationStateStructureSchema, { clientName: "checkpoint-marker" });
const tools: ChatCompletionRequest["tools"] = [
  {
    type: "function",
    function: { name: "read", description: "Read a file", parameters: { type: "object" } },
  },
];
const user = { role: "user" as const, content: "Review the changes; do not edit files." };
function toolMessages(id: string, result: string): ChatCompletionRequest["messages"] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "read", arguments: '{"path":"a.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

function emitTool(bridge: ReturnType<typeof fakeBridge>, id: string) {
  bridge.receive({
    case: "execServerMessage",
    value: {
      $typeName: "agent.v1.ExecServerMessage",
      id: 1,
      execId: id,
      message: {
        case: "mcpArgs",
        value: {
          $typeName: "agent.v1.McpArgs",
          name: "read",
          toolName: "read",
          providerIdentifier: "pi",
          toolCallId: id,
          args: {},
        },
      },
    },
  });
}

function emitText(bridge: ReturnType<typeof fakeBridge>, text: string) {
  bridge.receive({
    case: "interactionUpdate",
    value: {
      $typeName: "agent.v1.InteractionUpdate",
      message: {
        case: "textDelta",
        value: {
          $typeName: "agent.v1.TextDeltaUpdate",
          text,
        },
      },
    },
  });
}

describe("recovery publishes the active Pi transcript", () => {
  let dir: string;
  let bridges: ReturnType<typeof fakeBridge>[];
  let controllers: AbortController[];
  let build: MockInstance<typeof requestBuild.buildCursorRequest>;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-recovery-prompt-"));
    vi.stubEnv("PI_CURSOR_CACHE_DIR", dir);
    resetCacheDirForTests();
    bridges = [];
    controllers = [];
    build = vi.spyOn(requestBuild, "buildCursorRequest");
    __testInternals.setMetricEmitterForTests(() => {});
    setBridgeFactoryForTests(() => {
      const bridge = fakeBridge();
      bridges.push(bridge);
      return bridge;
    });
  });

  afterEach(() => {
    controllers.forEach((controller) => controller.abort());
    cleanupAllSessionState();
    destroyAllIdleBridges();
    setBridgeFactoryForTests();
    __testInternals.setMetricEmitterForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetCacheDirForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  async function request(messages: ChatCompletionRequest["messages"]) {
    const controller = new AbortController();
    controllers.push(controller);
    const onError = vi.fn();
    const writer: NativeStreamWriter = {
      output: {} as never,
      closed: false,
      start() {},
      text() {},
      thinking() {},
      toolCall() {},
      done() {
        this.closed = true;
      },
      error: onError,
    };
    await __testInternals.handleCursorNativeRequest(
      { model: "claude-opus-5-5", pi_session_id: sessionId, tools, messages },
      "test-token",
      {} as never,
      { signal: controller.signal },
      writer,
      "test-request",
    );
    expect(onError).not.toHaveBeenCalled();
    return writer;
  }

  function prompt() {
    const payload = build.mock.results.at(-1)!.value!;
    // Inspect the actual Run written to the transport, not just builder arguments.
    const sent = bridges.at(-1)!.write.mock.calls[0]![0] as Uint8Array;
    const message = fromBinary(AgentClientMessageSchema, sent.subarray(5));
    if (message.message.case !== "runRequest") throw new Error("expected Run");
    const state = message.message.value.conversationState!;
    const messages = state.rootPromptMessagesJson.map((id) =>
      JSON.parse(Buffer.from(payload.blobStore.get(Buffer.from(id).toString("hex"))!).toString()),
    ) as RootPromptMessage[];
    const action = message.message.value.action?.action;
    const images =
      action?.case === "userMessageAction"
        ? (action.value.userMessage?.selectedContext?.selectedImages ?? [])
        : [];
    return { messages, state, images, text: JSON.stringify(messages) };
  }

  it.each([false, true])(
    "keeps request, assistant work and tool data after bridge loss (checkpoint=%s)",
    async (hasCheckpoint) => {
      const fp = fingerprintCompletedTurns([]);
      conversationStates.set(convKey, {
        conversationId: "conv-test",
        checkpoint: hasCheckpoint ? toBinary(ConversationStateStructureSchema, checkpoint) : null,
        checkpointTurnCount: 0,
        checkpointHistoryFingerprint: fp,
        midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
        midPauseTurnCount: 0,
        midPauseHistoryFingerprint: fp,
        sessionScoped: true,
        sessionId,
        blobStore: new Map(),
        lastAccessMs: Date.now(),
      });
      const messages: ChatCompletionRequest["messages"] = [
        user,
        { role: "assistant", content: "I will review without editing." },
        ...toolMessages("t1", "first file contents"),
      ];
      await request(messages);
      const recovered = prompt();
      expect(recovered.text).toContain(user.content);
      expect(recovered.text).toContain("I will review without editing.");
      expect(recovered.messages.at(-1)).toMatchObject({
        role: "tool",
        content: [{ toolCallId: "t1", result: "first file contents" }],
      });
      expect(recovered.state.clientName).toBe(hasCheckpoint ? "checkpoint-marker" : "pi");

      // Another recovery in this same user turn must use Pi's complete transcript,
      // not the synthetic continuation as a new completed user turn.
      const bridge = bridges.at(-1)!;
      bridge.receive({ case: "conversationCheckpointUpdate", value: checkpoint });
      emitTool(bridge, "t2");
      bridge.close(0);
      await request([...messages, ...toolMessages("t2", "second file contents")]);
      const again = prompt();
      expect(again.text.split(user.content)).toHaveLength(2);
      expect(again.text).toContain("first file contents");
      expect(again.text).toContain("second file contents");
      expect(again.text).not.toContain("transport continuation");
    },
  );

  it.each([false, true])(
    "keeps the active turn when a live tool resume fails (checkpoint=%s)",
    async (hasCheckpoint) => {
      await request([user]);
      const bridge = bridges[0]!;
      if (hasCheckpoint)
        bridge.receive({ case: "conversationCheckpointUpdate", value: checkpoint });
      emitTool(bridge, "t1");
      await request([user, ...toolMessages("t1", "live result")]);
      if (hasCheckpoint) emitText(bridge, "Finding from the live result.");
      bridge.close(1);
      expect(bridges).toHaveLength(2);
      expect(prompt().text).toContain(user.content);
      expect(prompt().messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: [expect.objectContaining({ toolCallId: "t1", result: "live result" })],
        }),
      );
      if (hasCheckpoint) expect(prompt().text).toContain("Finding from the live result.");
    },
  );

  it("preserves original and tool images plus long results through recovery and another retry", async () => {
    conversationStates.set(convKey, {
      conversationId: "conv-images",
      checkpoint: null,
      sessionScoped: true,
      sessionId,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    });
    const image = (data: string) => ({
      type: "image_url" as const,
      image_url: { url: `data:image/png;base64,${data}` },
    });
    const originalPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const toolPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const longResult = "x".repeat(30_000) + "IMPORTANT TAIL";
    await request([
      { role: "user", content: [{ type: "text", text: user.content }, image(originalPng)] },
      toolMessages("t1", "")[0]!,
      {
        role: "tool",
        tool_call_id: "t1",
        is_error: true,
        content: [{ type: "text", text: longResult }, image(toolPng)],
      },
    ]);
    const recovered = prompt();
    expect(recovered.text).toContain("IMPORTANT TAIL");
    expect(recovered.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "t1", isError: true }],
    });
    expect(
      recovered.images.map((entry) =>
        entry.dataOrBlobId.case === "data"
          ? Buffer.from(entry.dataOrBlobId.value).toString("base64")
          : null,
      ),
    ).toEqual([originalPng, toolPng]);
    const bridge = bridges.at(-1)!;
    bridge.receive({ case: "conversationCheckpointUpdate", value: checkpoint });
    emitText(bridge, "Image finding.");
    bridge.close(1);
    expect(prompt().images.map((entry) => entry.dataOrBlobId.value)).toEqual(
      recovered.images.map((entry) => entry.dataOrBlobId.value),
    );
    expect(prompt().text).toContain("IMPORTANT TAIL");
  });

  it("keeps the user request and partial assistant output through repeated stream retries", async () => {
    await request([user]);
    for (const text of ["First finding.", "Second finding."]) {
      const bridge = bridges.at(-1)!;
      bridge.receive({ case: "conversationCheckpointUpdate", value: checkpoint });
      emitText(bridge, text);
      bridge.close(1);
      expect(prompt().text).toContain(user.content);
      expect(prompt().text).toContain(text);
    }
    expect(bridges).toHaveLength(3);
    expect(prompt().text).toContain("First finding.");
    expect(prompt().text.split(user.content)).toHaveLength(2);
    const finalBridge = bridges.at(-1)!;
    finalBridge.receive({ case: "conversationCheckpointUpdate", value: checkpoint });
    finalBridge.close(0);
    const stored = conversationStates.get(convKey)!;
    expect(stored.checkpointTurnCount).toBe(1);
    expect(stored.checkpointHistoryFingerprint).toBe(
      fingerprintCompletedTurns([
        {
          userText: user.content,
          steps: [{ kind: "assistantText", text: "First finding.Second finding." }],
        },
      ]),
    );
  });
});
