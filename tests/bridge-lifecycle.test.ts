import { create, toBinary } from "@bufbuild/protobuf";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { frameConnectMessage, type BridgeFactory } from "../src/client/bridge.js";
import { registerSessionLifecycleCleanup } from "../src/extension/debug-hooks.js";
import { AgentServerMessageSchema, type AgentServerMessage } from "../src/proto/agent_pb.js";
import {
  activeBridges,
  idleBridges,
  parkIdleBridge,
  setBridgeFactoryForTests,
} from "../src/stream/bridge-session.js";
import { __testInternals } from "../src/stream/native-core.js";
import {
  cleanupAllSessionState,
  conversationStates,
  deriveBridgeKey,
  deriveConversationKey,
} from "../src/stream/session-state.js";
import type { NativeStreamWriter } from "../src/stream/types.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";

function fakeBridge() {
  let onData = (_chunk: Buffer) => {};
  let onClose = (_code: number) => {};
  let onStreamDone = () => {};
  const bridge = {
    alive: true,
    proc: { kill: () => true },
    lastStderr: () => "",
    write: vi.fn(),
    openStream: vi.fn(),
    end: vi.fn(() => {
      bridge.alive = false;
      onClose(0);
    }),
    onData(callback: typeof onData) {
      onData = callback;
    },
    onClose(callback: typeof onClose) {
      onClose = callback;
    },
    onStreamDone(callback: typeof onStreamDone) {
      onStreamDone = callback;
    },
    finishStream() {
      onStreamDone();
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
  };
  return bridge;
}

const messages = [{ role: "user" as const, content: "Compute 2**100." }];
const sessionId = "bridge-lifecycle-test";

describe("completed bridge lifecycle", () => {
  let dir: string;
  let bridges: ReturnType<typeof fakeBridge>[];
  let factory: Mock<BridgeFactory>;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-bridge-lifecycle-"));
    vi.stubEnv("PI_CURSOR_CACHE_DIR", dir);
    resetCacheDirForTests();
    bridges = [];
    factory = vi.fn(() => {
      const bridge = fakeBridge();
      bridges.push(bridge);
      return bridge;
    });
    setBridgeFactoryForTests(factory);
    __testInternals.setMetricEmitterForTests(() => {});
  });

  afterEach(() => {
    cleanupAllSessionState();
    setBridgeFactoryForTests();
    __testInternals.setMetricEmitterForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetCacheDirForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  async function request(id?: string) {
    const done = vi.fn();
    const error = vi.fn();
    const writer: NativeStreamWriter = {
      output: {} as never,
      closed: false,
      start() {},
      text() {},
      thinking() {},
      toolCall() {},
      done(reason) {
        done(reason);
        this.closed = true;
      },
      error,
    };
    await __testInternals.handleCursorNativeRequest(
      {
        model: "claude-opus-5-5",
        pi_session_id: id,
        messages,
        tools: [
          {
            type: "function",
            function: { name: "ipython", parameters: { type: "object" } },
          },
        ],
      },
      "test-token",
      {} as never,
      undefined,
      writer,
      "test-request",
    );
    expect(error).not.toHaveBeenCalled();
    return { done, error };
  }

  it("ends anonymous completions instead of retaining their HTTP/2 sockets", async () => {
    const { done, error } = await request();
    const bridge = bridges[0]!;
    bridge.finishStream();
    bridge.finishStream(); // Cleanup and terminal events must be idempotent.
    expect(done.mock.calls).toEqual([["stop"]]);
    expect(error).not.toHaveBeenCalled();
    expect(bridge.end).toHaveBeenCalledTimes(1);
    expect(bridge.alive).toBe(false);
    expect(idleBridges.size).toBe(0);
    expect(activeBridges.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps session-owned connections reusable for the next turn", async () => {
    const { done } = await request(sessionId);
    const bridge = bridges[0]!;
    bridge.finishStream();
    expect(done.mock.calls).toEqual([["stop"]]);
    expect(bridge.end).not.toHaveBeenCalled();
    expect(idleBridges.get(deriveBridgeKey(messages, sessionId))?.bridge).toBe(bridge);
    await request(sessionId);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(bridge.openStream).toHaveBeenCalledWith("test-token");
    expect(idleBridges.size).toBe(0);
    bridge.finishStream();
  });

  it.each([undefined, sessionId])(
    "retains live tool pauses but closes streams that end mid-pause (session=%s)",
    async (id) => {
      const { done, error } = await request(id);
      const bridge = bridges[0]!;
      bridge.receive({
        case: "execServerMessage",
        value: {
          $typeName: "agent.v1.ExecServerMessage",
          id: 1,
          execId: "exec-tool",
          message: {
            case: "mcpArgs",
            value: {
              $typeName: "agent.v1.McpArgs",
              name: "ipython",
              toolName: "ipython",
              providerIdentifier: "pi",
              toolCallId: "call-tool",
              args: {},
            },
          },
        },
      });
      expect(done.mock.calls).toEqual([["toolUse"]]);
      expect(bridge.end).not.toHaveBeenCalled();
      expect(activeBridges.has(deriveBridgeKey(messages, id))).toBe(true);
      bridge.finishStream();
      expect(bridge.end).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledTimes(1);
      expect(activeBridges.size).toBe(0);
      expect(idleBridges.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        conversationStates.get(deriveConversationKey(messages, id))?.midPausePendingToolCalls,
      ).toEqual([{ toolCallId: "call-tool", toolName: "ipython" }]);
    },
  );

  it("drains all idle bridges on shutdown, but not when navigating sessions", () => {
    const hooks = new Map<string, (event: never, ctx: ExtensionContext) => void>();
    registerSessionLifecycleCleanup({
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => void) => {
        hooks.set(event, handler);
      },
    } as unknown as ExtensionAPI);
    const ctx = { sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
    const own = fakeBridge();
    const child = fakeBridge();
    parkIdleBridge(deriveBridgeKey(messages, sessionId), own);
    parkIdleBridge("content-keyed-child", child);

    hooks.get("session_before_switch")!({} as never, ctx);
    expect(own.end).toHaveBeenCalledTimes(1);
    expect(child.end).not.toHaveBeenCalled();
    expect(idleBridges.size).toBe(1);

    hooks.get("session_shutdown")!({} as never, ctx);
    hooks.get("session_shutdown")!({} as never, ctx);
    expect(own.end).toHaveBeenCalledTimes(1);
    expect(child.end).toHaveBeenCalledTimes(1);
    expect(idleBridges.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
