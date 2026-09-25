import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  ExecServerMessageSchema,
  McpStateServerSchema,
} from "../src/proto/agent_pb.js";
import { buildMcpToolDefinitions } from "../src/stream/request-build.js";
import { __testInternals } from "../src/stream/server-messages.js";

// Cursor CLI's wire shape: id=12, exec_id="exec-12", field 36 contains
// McpStateExecArgs { server_identifiers: ["pi"], kick_only: true }.
// Keep this independent of our encoder so a schema regression cannot round-trip unnoticed.
const requestBytes = Buffer.from("080c7a07657865632d3132a202060a0270691001", "hex");

const tools = buildMcpToolDefinitions([
  {
    type: "function",
    function: {
      name: "ipython",
      description: "Execute Python in a persistent kernel",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "future_extension_tool",
      description: "Another extension tool",
      parameters: { type: "object" },
    },
  },
]);

function catalog(requestTools = tools) {
  const request = fromBinary(ExecServerMessageSchema, requestBytes);
  const frames: Uint8Array[] = [];
  const onMcpExec = vi.fn();
  expect(
    __testInternals.handleExecMessageInner(
      request,
      requestTools,
      (frame) => frames.push(frame),
      onMcpExec,
    ),
  ).toBe(true);
  expect(onMcpExec).not.toHaveBeenCalled();
  expect(frames).toHaveLength(1);
  const answer = fromBinary(AgentClientMessageSchema, Uint8Array.from(frames[0]!.subarray(5)));
  if (answer.message.case !== "execClientMessage") throw new Error("expected exec reply");
  const exec = answer.message.value;
  expect(exec.id).toBe(12);
  expect(exec.execId).toBe("exec-12");
  if (exec.message.case !== "mcpStateExecResult") throw new Error("expected MCP state");
  const result = exec.message.value.result;
  if (result.case !== "success") throw new Error("expected success");
  return { exec, servers: result.value.servers };
}

describe("MCP dynamic tool catalog", () => {
  it("decodes field 36 as MCP state rather than grind planning", () => {
    const request = fromBinary(ExecServerMessageSchema, requestBytes);
    expect(request.message).toMatchObject({
      case: "mcpStateExecArgs",
      value: { serverIdentifiers: ["pi"], kickOnly: true },
    });
  });

  it("returns one connected pi server with the request's tools and schemas", () => {
    expect(catalog().servers).toEqual([
      create(McpStateServerSchema, {
        serverName: "pi",
        serverIdentifier: "pi",
        tools,
        instructions: [],
        status: "connected",
      }),
    ]);
    // Pin the nested wire tags as well: a symmetric encode/decode alone cannot
    // detect tools accidentally moving away from Cursor's field 5.
    expect(McpStateServerSchema.field.tools.number).toBe(5);
    expect(McpStateServerSchema.field.instructions.number).toBe(6);
  });

  it("returns a valid field-36 success even when no tools are selected", () => {
    const { exec, servers } = catalog([]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.tools).toEqual([]);
    // field 36 -> success(1) -> servers(1) -> name(1), identifier(2), status(7).
    expect(Buffer.from(toBinary(ExecClientMessageSchema, exec)).toString("hex")).toBe(
      "080c7a07657865632d3132a202170a150a130a027069120270693a09636f6e6e6563746564",
    );
  });
});
