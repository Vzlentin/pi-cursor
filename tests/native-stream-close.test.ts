import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  ShellArgsSchema,
} from "../src/proto/agent_pb.js";
import { __testInternals } from "../src/stream/server-messages.js";

describe("native shell stream completion", () => {
  beforeEach(() => {
    process.env.PI_CURSOR_NATIVE_TOOLS = "native";
  });
  afterEach(() => {
    delete process.env.PI_CURSOR_NATIVE_TOOLS;
  });

  it.each([0, 7])("closes the exec RPC after shell exit %i", async (exitCode) => {
    const frames: Uint8Array[] = [];
    const pending: Promise<void>[] = [];
    const exec = create(ExecServerMessageSchema, {
      id: 41,
      execId: "native-shell-test",
      message: {
        case: "shellStreamArgs",
        value: create(ShellArgsSchema, {
          command: `echo native-stream-result; exit ${exitCode}`,
          workingDirectory: process.cwd(),
        }),
      },
    });
    expect(
      __testInternals.handleExecMessageInner(
        exec,
        [],
        (frame) => frames.push(frame),
        () => {
          throw new Error("Native shell must not become an MCP call");
        },
        (work) => pending.push(work),
      ),
    ).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const messages = frames.map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
    const streamEvents = messages.flatMap((message) => {
      if (message.message.case !== "execClientMessage") return [];
      expect(message.message.value.id).toBe(41);
      const result = message.message.value.message;
      return result.case === "shellStream" ? [result.value.event] : [];
    });
    expect(streamEvents.map((event) => event.case)).toEqual(["start", "stdout", "exit"]);
    expect(streamEvents[1]?.value).toMatchObject({
      data: expect.stringContaining("native-stream-result"),
    });
    expect(streamEvents[2]?.value).toMatchObject({ code: exitCode });
    expect(messages.at(-1)?.message).toMatchObject({
      case: "execClientControlMessage",
      value: { message: { case: "streamClose", value: { id: 41 } } },
    });
  });
});
