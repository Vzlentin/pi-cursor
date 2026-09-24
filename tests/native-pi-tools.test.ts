import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  McpToolDefinitionSchema,
} from "../src/proto/agent_pb.js";
import {
  computeReplaceEdits,
  createNativeCallTracker,
  parseBashOutcome,
} from "../src/stream/native-pi-tools.js";
import { processServerMessage, sendPiResultForNativeExec } from "../src/stream/server-messages.js";
import type { PendingExec, StreamState } from "../src/stream/types.js";

const piTools = (...names: string[]) =>
  names.map((name) =>
    create(McpToolDefinitionSchema, { name, toolName: name, providerIdentifier: "pi" }),
  );

function harness(tools = piTools("read", "bash", "edit", "write")) {
  const frames: Uint8Array[] = [];
  const execs: PendingExec[] = [];
  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    nativeCalls: createNativeCallTracker(),
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
  };
  const send = (message: MessageInitShape<typeof AgentServerMessageSchema>["message"]) =>
    processServerMessage(
      create(AgentServerMessageSchema, { message }),
      new Map(),
      tools,
      (frame) => frames.push(frame),
      state,
      () => {},
      (exec) => execs.push(exec),
    );
  return {
    execs,
    announce(callId: string, tool: any) {
      send({
        case: "interactionUpdate",
        value: { message: { case: "toolCallStarted", value: { callId, toolCall: { tool } } } },
      });
    },
    exec(id: number, execCase: string, value: Record<string, unknown>) {
      send({
        case: "execServerMessage",
        value: { id, execId: `exec-${id}`, message: { case: execCase, value } as any },
      });
    },
    answer(exec: PendingExec, content: string, isError = false) {
      sendPiResultForNativeExec(exec, { content, isError }, (frame) => frames.push(frame));
    },
    piArgs(index = 0) {
      return JSON.parse(execs[index]!.decodedArgs) as Record<string, any>;
    },
    /** Client messages sent so far, consumed. */
    replies() {
      const messages = frames.map((frame) =>
        fromBinary(AgentClientMessageSchema, frame.subarray(5)),
      );
      frames.length = 0;
      return messages.map((message) => {
        if (message.message.case === "execClientControlMessage") {
          const control = message.message.value.message;
          return { control: control.case, id: (control.value as { id: number }).id };
        }
        if (message.message.case !== "execClientMessage") return { other: message.message.case };
        const exec = message.message.value;
        return {
          id: exec.id,
          execId: exec.execId,
          case: exec.message.case,
          value: exec.message.value as any,
        };
      });
    },
  };
}

describe("native Cursor tools routed through Pi", () => {
  const previousCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-cursor-route-")));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CURSOR_NATIVE_TOOLS;
  });

  it("runs a model read as a Pi read and returns the whole file to Cursor", () => {
    writeFileSync("note.md", "one\ntwo\nthree\n");
    const h = harness();
    const file = path.join(dir, "note.md");
    h.announce("toolu_read", {
      case: "readToolCall",
      value: { args: { path: file, offset: 2, limit: 1 } },
    });
    h.exec(1, "readArgs", { path: file, toolCallId: "toolu_read" });

    expect(h.replies()).toEqual([]);
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]).toMatchObject({ toolName: "read", toolCallId: "toolu_read", execMsgId: 1 });
    expect(h.piArgs()).toEqual({ path: "note.md", offset: 2, limit: 1 });

    h.answer(h.execs[0]!, "two");
    const [reply] = h.replies();
    expect(reply).toMatchObject({ id: 1, execId: "exec-1", case: "readResult" });
    expect(reply!.value.result.case).toBe("success");
    expect(reply!.value.result.value.output).toMatchObject({
      case: "content",
      value: "one\ntwo\nthree\n",
    });
  });

  it("reports a failed Pi read of a missing file as not found", () => {
    const h = harness();
    h.exec(1, "readArgs", { path: "missing.txt", toolCallId: "toolu_missing" });
    h.answer(h.execs[0]!, "ENOENT: no such file or directory", true);
    expect(h.replies()[0]!.value.result.case).toBe("fileNotFound");
  });

  it("answers an edit's own read directly and runs its write as a Pi edit", () => {
    const before = "x\nreturn a - b;\ny\nreturn a - b;\n";
    const after = "x\nreturn a - b;\ny\nreturn a + b;\n";
    writeFileSync("math.js", before);
    const h = harness();
    h.announce("toolu_edit", { case: "editToolCall", value: { args: { path: "math.js" } } });

    h.exec(2, "readArgs", { path: "math.js", toolCallId: "toolu_edit" });
    const [read] = h.replies();
    expect(read).toMatchObject({ id: 2, case: "readResult" });
    expect(read!.value.result.value.output.value).toBe(before);
    expect(h.execs).toHaveLength(0);

    h.exec(3, "writeArgs", { path: "math.js", fileText: after, toolCallId: "toolu_edit" });
    expect(h.execs[0]).toMatchObject({ toolName: "edit", execMsgId: 3 });
    expect(h.piArgs()).toEqual({
      path: "math.js",
      edits: [{ oldText: "y\nreturn a - b;\n", newText: "y\nreturn a + b;\n" }],
    });

    writeFileSync("math.js", after);
    h.answer(h.execs[0]!, "Successfully replaced 1 block(s) in math.js.");
    const [write] = h.replies();
    expect(write).toMatchObject({ id: 3, case: "writeResult" });
    expect(write!.value.result).toMatchObject({
      case: "success",
      value: { path: "math.js", linesCreated: 5, fileSize: after.length },
    });
  });

  it("creates a new file with a Pi write after its not-found read", () => {
    const h = harness();
    h.announce("toolu_new", { case: "editToolCall", value: { args: { path: "new.txt" } } });
    h.exec(4, "readArgs", { path: "new.txt", toolCallId: "toolu_new" });
    expect(h.replies()[0]!.value.result.case).toBe("fileNotFound");

    h.exec(5, "writeArgs", { path: "new.txt", fileText: "hello\n", toolCallId: "toolu_new" });
    expect(h.execs[0]!.toolName).toBe("write");
    expect(h.piArgs()).toEqual({ path: "new.txt", content: "hello\n" });

    h.answer(h.execs[0]!, "Error: disk full", true);
    expect(h.replies()[0]!.value.result).toMatchObject({
      case: "error",
      value: { error: "Error: disk full" },
    });
  });

  it("answers a write that changes nothing without a Pi call", () => {
    writeFileSync("same.txt", "same\n");
    const h = harness();
    h.exec(6, "writeArgs", { path: "same.txt", fileText: "same\n", toolCallId: "toolu_same" });
    expect(h.execs).toHaveLength(0);
    expect(h.replies()[0]!.value.result.case).toBe("success");
  });

  it("streams a Pi bash result back to Cursor and closes the exec", () => {
    const h = harness();
    h.exec(7, "shellStreamArgs", {
      command: "npm test",
      workingDirectory: dir,
      timeout: 30000,
      toolCallId: "toolu_shell",
    });
    expect(h.execs[0]!.toolName).toBe("bash");
    expect(h.piArgs()).toEqual({ command: "npm test" });

    h.answer(h.execs[0]!, "1 failing\n\nCommand exited with code 3", true);
    const replies = h.replies();
    expect(replies.map((reply) => reply.value?.event?.case ?? reply.control)).toEqual([
      "start",
      "stdout",
      "exit",
      "streamClose",
    ]);
    expect(replies[1]!.value.event.value.data).toBe("1 failing");
    expect(replies[2]!.value.event.value).toMatchObject({ code: 3, cwd: dir });
    expect(replies[3]).toEqual({ control: "streamClose", id: 7 });
  });

  it("runs a shell command in another directory through cd", () => {
    mkdirSync("sub");
    const h = harness();
    h.exec(8, "shellArgs", {
      command: "ls; pwd",
      workingDirectory: path.join(dir, "sub"),
      toolCallId: "toolu_cd",
    });
    expect(h.piArgs()).toEqual({ command: "cd sub && {\nls; pwd\n}" });

    h.answer(h.execs[0]!, "(no output)");
    expect(h.replies()[0]!.value.result).toMatchObject({
      case: "success",
      value: { exitCode: 0, stdout: "" },
    });
  });

  it("maps ripgrep output, including context lines and dashed names, to grep matches", () => {
    writeFileSync("my-1-file.txt", "before\nneedle here\n");
    writeFileSync("other.txt", "\n\n\n\nneedle\n");
    const h = harness();
    h.exec(9, "grepArgs", {
      pattern: "needle",
      path: ".",
      contextBefore: 1,
      toolCallId: "toolu_grep",
    });
    const command = h.piArgs().command as string;
    expect(command).toMatch(/^rg .*--line-number.* -B 1 .*-e needle \| head -n 300$/);

    h.answer(
      h.execs[0]!,
      "my-1-file.txt-1-before\nmy-1-file.txt:2:needle here\n--\nother.txt:5:needle",
    );
    const [reply] = h.replies();
    const success = reply!.value.result;
    expect(success.case).toBe("success");
    const content = success.value.workspaceResults[dir].result;
    expect(content.case).toBe("content");
    expect(content.value.totalMatchedLines).toBe(2);
    expect(
      content.value.matches.map((file: any) => [
        file.file,
        file.matches.map((m: any) => [m.lineNumber, m.content, m.isContextLine]),
      ]),
    ).toEqual([
      [
        "my-1-file.txt",
        [
          [1, "before", true],
          [2, "needle here", false],
        ],
      ],
      ["other.txt", [[5, "needle", false]]],
    ]);
  });

  it("reports ripgrep's own errors as a grep error", () => {
    const h = harness();
    h.exec(10, "grepArgs", { pattern: "(", toolCallId: "toolu_bad" });
    h.answer(h.execs[0]!, "rg: regex parse error:\n    (\n    ^\nerror: unclosed group");
    expect(h.replies()[0]!.value.result).toMatchObject({
      case: "error",
      value: { error: expect.stringContaining("regex parse error") },
    });
  });

  it("lists a directory through bash when Pi has no ls tool", () => {
    const h = harness();
    h.exec(11, "lsArgs", { path: ".", ignore: ["*.log"], toolCallId: "toolu_ls" });
    expect(h.piArgs()).toEqual({ command: "ls -1Ap" });

    h.answer(h.execs[0]!, "a.txt\nb.log\nsrc/\n");
    const root = h.replies()[0]!.value.result.value.directoryTreeRoot;
    expect(root.absPath).toBe(dir);
    expect(root.childrenFiles.map((file: any) => file.name)).toEqual(["a.txt"]);
    expect(root.childrenDirs.map((node: any) => node.absPath)).toEqual([path.join(dir, "src")]);
  });

  it("deletes a file through bash rm", () => {
    writeFileSync("gone.txt", "bye\n");
    const h = harness();
    h.exec(12, "deleteArgs", { path: "gone.txt", toolCallId: "toolu_rm" });
    expect(h.piArgs()).toEqual({ command: "rm -- gone.txt" });

    rmSync("gone.txt");
    h.answer(h.execs[0]!, "(no output)");
    expect(h.replies()[0]!.value.result).toMatchObject({
      case: "success",
      value: { path: "gone.txt", prevContent: "bye\n" },
    });
  });

  it("rejects a native exec whose Pi tool is not available", () => {
    const h = harness(piTools("read"));
    h.exec(13, "shellStreamArgs", { command: "ls", toolCallId: "toolu_nobash" });
    expect(h.execs).toHaveLength(0);
    const replies = h.replies();
    expect(replies[0]!.value.event.case).toBe("rejected");
    expect(replies[0]!.value.event.value.reason).toContain('"bash"');
    expect(replies[1]).toEqual({ control: "streamClose", id: 13 });
  });

  it("executes inside the provider when PI_CURSOR_NATIVE_TOOLS=native", () => {
    process.env.PI_CURSOR_NATIVE_TOOLS = "native";
    writeFileSync("note.md", "native\n");
    const h = harness();
    h.exec(14, "readArgs", { path: "note.md", toolCallId: "toolu_native" });
    expect(h.execs).toHaveLength(0);
    expect(h.replies()[0]!.value.result.case).toBe("success");
  });
});

describe("edit hunks for Cursor writes", () => {
  it("widens context until the replaced text is unique", () => {
    expect(computeReplaceEdits("a\nb\na\nb\n", "a\nb\na\nc\n")).toEqual([
      { oldText: "b\na\nb\n", newText: "b\na\nc\n" },
    ]);
  });

  it("anchors pure insertions on a neighbouring line", () => {
    expect(computeReplaceEdits("one\ntwo\n", "one\ninserted\ntwo\n")).toEqual([
      { oldText: "one\n", newText: "one\ninserted\n" },
    ]);
  });

  it("matches on LF-normalized text", () => {
    expect(computeReplaceEdits("a\r\nb\r\n", "a\r\nc\r\n")).toEqual([
      { oldText: "b\n", newText: "c\n" },
    ]);
  });

  it("leaves BOM files, empty files and rewrites to Pi's write", () => {
    expect(computeReplaceEdits("\uFEFFa\n", "\uFEFFb\n")).toBeNull();
    expect(computeReplaceEdits("", "new\n")).toBeNull();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
    expect(
      computeReplaceEdits(lines.join(""), lines.map((line) => line.toUpperCase()).join("")),
    ).toBeNull();
  });
});

describe("Pi bash outcomes", () => {
  it("separates output from Pi's status line", () => {
    expect(parseBashOutcome({ content: "ok", isError: false })).toMatchObject({
      outcome: "ok",
      exitCode: 0,
      output: "ok",
    });
    expect(
      parseBashOutcome({ content: "(no output)\n\nCommand exited with code 2", isError: true }),
    ).toMatchObject({ outcome: "exit", exitCode: 2, output: "" });
    expect(
      parseBashOutcome({ content: "partial\n\nCommand timed out after 5 seconds", isError: true }),
    ).toMatchObject({ outcome: "timeout", timeoutSeconds: 5, output: "partial" });
    expect(parseBashOutcome({ content: "Command aborted", isError: true })).toMatchObject({
      outcome: "aborted",
    });
    expect(parseBashOutcome({ content: "Blocked by policy", isError: true })).toMatchObject({
      outcome: "refused",
      output: "Blocked by policy",
    });
  });
});
