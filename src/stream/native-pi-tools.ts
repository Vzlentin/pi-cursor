/**
 * Runs Cursor-native local exec requests through Pi's registered tools.
 *
 * Cursor's server drives its own tool set (read, edit, shell, grep, ls, delete)
 * and asks the client to perform each operation as a typed exec message.
 * Executing those inside the provider hides them from Pi: no tool call, no
 * result, no hooks. Here each one becomes a Pi tool call instead. The stream
 * pauses exactly as it does for an MCP call, Pi executes and records the tool,
 * and its result is encoded back into the native shape the server waits for.
 *
 * Cursor implements an edit as a read of the current file followed by a write
 * of the complete new content, both carrying the edit's tool call id. That read
 * is answered directly so the server edits exact file content; the write becomes
 * a Pi `edit` computed against the content that was read, or a Pi `write` for
 * new files and near-total rewrites.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { create, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

import {
  DeleteErrorSchema,
  DeleteFileNotFoundSchema,
  DeleteNotFileSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepCountResultSchema,
  GrepErrorSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNode_FileSchema,
  LsDirectoryTreeNodeSchema,
  LsErrorSchema,
  LsRejectedSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  ShellFailureSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  ShellTimeoutSchema,
  WriteErrorSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type GrepUnionResult,
} from "../proto/agent_pb.js";
import { emptyGrepPatternRejection, execRead, type NativeExecFrame } from "./exec-native.js";
import type { ParsedToolResult } from "./types.js";

export type NativeToolRouting = "pi" | "native";

/** `PI_CURSOR_NATIVE_TOOLS=native` executes local tools inside the provider instead of through Pi. */
export function resolveNativeToolRouting(
  value = process.env.PI_CURSOR_NATIVE_TOOLS,
): NativeToolRouting {
  return value?.trim().toLowerCase() === "native" ? "native" : "pi";
}

export const PI_ROUTED_EXEC_CASES: ReadonlySet<string> = new Set([
  "readArgs",
  "writeArgs",
  "deleteArgs",
  "lsArgs",
  "grepArgs",
  "shellArgs",
  "shellStreamArgs",
]);

const MAX_TRACKED_ENTRIES = 256;
const MAX_DELETE_PREV_CONTENT_BYTES = 16_384;
const DEFAULT_GREP_OUTPUT_LINES = 300;
/** Above this share of changed lines, a Pi `write` shows the change better than an `edit`. */
const REWRITE_CHANGED_LINE_RATIO = 0.9;
const REWRITE_MIN_LINES = 20;
/** Repetitive files could otherwise need unbounded context before a hunk is unique. */
const MAX_EDIT_CONTEXT_LINES = 40;

// ── Cursor tool-call tracking ──

interface CursorToolCallInfo {
  kind: string;
  readOffset?: number;
  readLimit?: number;
}

export interface NativeCallTracker {
  calls: Map<string, CursorToolCallInfo>;
  /** Content an edit was computed from, by Cursor tool call id; null when the file was absent. */
  editBases: Map<string, string | null>;
  piToolCallIds: Map<string, true>;
}

const trackers = new WeakMap<object, NativeCallTracker>();

export function createNativeCallTracker(): NativeCallTracker {
  return { calls: new Map(), editBases: new Map(), piToolCallIds: new Map() };
}

/** One tracker per bridge: announcements and edit bases must outlive a tool pause. */
export function nativeCallTrackerFor(owner: object): NativeCallTracker {
  let tracker = trackers.get(owner);
  if (!tracker) {
    tracker = createNativeCallTracker();
    trackers.set(owner, tracker);
  }
  return tracker;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Records which model-level tool an upcoming exec belongs to. Cursor announces
 * each call (`partialToolCall`, then `toolCallStarted`) before issuing its execs.
 */
export function noteCursorToolCall(tracker: NativeCallTracker, update: unknown): void {
  const value = update as {
    callId?: unknown;
    toolCall?: { tool?: { case?: unknown; value?: any } };
  };
  const callId = typeof value?.callId === "string" ? value.callId : "";
  const tool = value?.toolCall?.tool;
  if (!callId || typeof tool?.case !== "string") return;
  const info: CursorToolCallInfo = { kind: tool.case };
  const readArgs = tool.case === "readToolCall" ? tool.value?.args : undefined;
  if (typeof readArgs?.offset === "number") info.readOffset = readArgs.offset;
  if (typeof readArgs?.limit === "number") info.readLimit = readArgs.limit;
  remember(tracker.calls, callId, info);
}

function uniquePiToolCallId(tracker: NativeCallTracker, cursorToolCallId: string): string {
  let id = cursorToolCallId || `cursor_native_${randomUUID()}`;
  if (tracker.piToolCallIds.has(id)) id = `${id}_${randomUUID().slice(0, 8)}`;
  remember(tracker.piToolCallIds, id, true);
  return id;
}

// ── Routing ──

type GrepOutputMode = "content" | "files_with_matches" | "count";

export type NativeExecBinding =
  | { execCase: "readArgs"; path: string }
  | { execCase: "writeArgs"; path: string; fileText: string; returnFileContent: boolean }
  | { execCase: "deleteArgs"; path: string; fileSize: number; prevContent: string }
  | { execCase: "lsArgs"; path: string; ignore: string[] }
  | {
      execCase: "grepArgs";
      pattern: string;
      path: string;
      outputMode: GrepOutputMode;
      limit: number;
    }
  | {
      execCase: "shellArgs" | "shellStreamArgs";
      command: string;
      workingDirectory: string;
      startedAtMs: number;
    };

export interface NativeExecReply {
  frames: NativeExecFrame[];
  /** Streaming execs stay open after their last event until the client closes them. */
  closeStream: boolean;
}

export type NativeRouteDecision =
  | {
      kind: "pi";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      binding: NativeExecBinding;
    }
  | { kind: "respond"; reply: NativeExecReply };

function reply(frames: NativeExecFrame[], closeStream = false): NativeRouteDecision {
  return { kind: "respond", reply: { frames, closeStream } };
}

/** Decides how one native exec runs: as a Pi tool call, or answered here without side effects. */
export function planNativePiRoute(
  execCase: string,
  args: Record<string, unknown>,
  availableTools: readonly string[],
  tracker: NativeCallTracker,
): NativeRouteDecision {
  const has = (name: string) => availableTools.includes(name);
  const cursorToolCallId = str(args.toolCallId);
  const pi = (
    toolName: string,
    piArgs: Record<string, unknown>,
    binding: NativeExecBinding,
  ): NativeRouteDecision => ({
    kind: "pi",
    toolCallId: uniquePiToolCallId(tracker, cursorToolCallId),
    toolName,
    args: piArgs,
    binding,
  });
  const unavailable = (tool: string): NativeRouteDecision =>
    reply(
      rejectionFrames(
        execCase,
        args,
        `Pi's "${tool}" tool is not available in this session, so this operation cannot run.`,
      ),
      execCase === "shellStreamArgs",
    );

  switch (execCase) {
    case "readArgs": {
      const rawPath = str(args.path);
      const info = cursorToolCallId ? tracker.calls.get(cursorToolCallId) : undefined;
      if (info && info.kind !== "readToolCall") {
        const frame = execRead({ path: rawPath }, { unconfined: true });
        const base = readFrameText(frame);
        if (base !== undefined) remember(tracker.editBases, cursorToolCallId, base);
        return reply([frame]);
      }
      if (!has("read")) return unavailable("read");
      const piArgs: Record<string, unknown> = { path: piPath(rawPath) };
      if (info?.readOffset && info.readOffset > 0) piArgs.offset = info.readOffset;
      if (info?.readLimit && info.readLimit > 0) piArgs.limit = info.readLimit;
      return pi("read", piArgs, { execCase, path: rawPath });
    }

    case "writeArgs": {
      const rawPath = str(args.path);
      const fileText = writeText(args);
      if (fileText === undefined) {
        return reply(
          rejectionFrames(execCase, args, "Binary file writes are not supported through Pi tools."),
        );
      }
      const current = readTextFile(resolvePath(rawPath));
      const recorded = cursorToolCallId ? tracker.editBases.get(cursorToolCallId) : undefined;
      if (cursorToolCallId) tracker.editBases.delete(cursorToolCallId);
      const base = recorded !== undefined ? recorded : current;
      const binding: NativeExecBinding = {
        execCase,
        path: rawPath,
        fileText,
        returnFileContent: args.returnFileContentAfterWrite === true,
      };
      if (base === fileText && current === fileText) return reply([writeSuccessFrame(binding)]);
      if (typeof base === "string" && typeof current === "string" && has("edit")) {
        const edits = computeReplaceEdits(base, fileText);
        if (edits) return pi("edit", { path: piPath(rawPath), edits }, binding);
      }
      if (!has("write")) return unavailable("write");
      return pi("write", { path: piPath(rawPath), content: fileText }, binding);
    }

    case "deleteArgs": {
      const rawPath = str(args.path);
      const absPath = resolvePath(rawPath);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(absPath);
      } catch {
        return reply([
          deleteFrame({
            case: "fileNotFound",
            value: create(DeleteFileNotFoundSchema, { path: rawPath }),
          }),
        ]);
      }
      if (stat.isDirectory()) {
        return reply([
          deleteFrame({
            case: "notFile",
            value: create(DeleteNotFileSchema, { path: rawPath, actualType: "directory" }),
          }),
        ]);
      }
      if (!has("bash")) return unavailable("bash");
      return pi(
        "bash",
        { command: `rm -- ${shellArg(piPath(rawPath))}` },
        {
          execCase,
          path: rawPath,
          fileSize: Number(stat.size),
          prevContent: stat.isFile() ? readTextPrefix(absPath, MAX_DELETE_PREV_CONTENT_BYTES) : "",
        },
      );
    }

    case "lsArgs": {
      const rawPath = str(args.path) || ".";
      const ignore = Array.isArray(args.ignore)
        ? args.ignore.filter((glob): glob is string => typeof glob === "string" && glob.length > 0)
        : [];
      const binding: NativeExecBinding = { execCase, path: rawPath, ignore };
      const target = piPath(rawPath);
      if (has("ls")) return pi("ls", { path: target }, binding);
      if (!has("bash")) return unavailable("bash");
      return pi(
        "bash",
        { command: target === "." ? "ls -1Ap" : `ls -1Ap -- ${shellArg(target)}` },
        binding,
      );
    }

    case "grepArgs": {
      const pattern = str(args.pattern);
      const empty = emptyGrepPatternRejection(pattern, str(args.glob) || undefined);
      if (empty) return reply([grepErrorFrame(empty)]);
      if (!has("bash")) return unavailable("bash");
      const outputMode = grepOutputMode(args.outputMode);
      const limit = positiveInt(args.headLimit) ?? DEFAULT_GREP_OUTPUT_LINES;
      const rawPath = str(args.path) || ".";
      return pi(
        "bash",
        { command: ripgrepCommand(args, pattern, piPath(rawPath), outputMode, limit) },
        { execCase, pattern, path: rawPath, outputMode, limit },
      );
    }

    case "shellArgs":
    case "shellStreamArgs": {
      const command = str(args.command);
      const binding: NativeExecBinding = {
        execCase,
        command,
        workingDirectory: resolvePath(str(args.workingDirectory) || "."),
        startedAtMs: Date.now(),
      };
      if (!command.trim()) {
        return reply(
          shellFrames(binding, { output: "Empty command", exitCode: 1, outcome: "exit" }),
          execCase === "shellStreamArgs",
        );
      }
      if (!has("bash")) return unavailable("bash");
      return pi(
        "bash",
        {
          command: piShellCommand(command, binding.workingDirectory, args.isBackground === true),
        },
        binding,
      );
    }

    default:
      return reply(rejectionFrames(execCase, args, `Unsupported native exec "${execCase}".`));
  }
}

// ── Results ──

/** Encodes Pi's result for a routed exec as the native reply Cursor is waiting on. */
export function nativeResultReply(
  binding: NativeExecBinding,
  result: ParsedToolResult,
): NativeExecReply {
  switch (binding.execCase) {
    case "readArgs":
      return { frames: [readResultFrame(binding.path, result)], closeStream: false };
    case "writeArgs":
      return {
        frames: [
          result.isError
            ? writeFrame({
                case: "error",
                value: create(WriteErrorSchema, { path: binding.path, error: result.content }),
              })
            : writeSuccessFrame(binding),
        ],
        closeStream: false,
      };
    case "deleteArgs":
      return { frames: [deleteResultFrame(binding, result)], closeStream: false };
    case "lsArgs":
      return { frames: [lsResultFrame(binding, result)], closeStream: false };
    case "grepArgs":
      return { frames: [grepResultFrame(binding, result)], closeStream: false };
    case "shellArgs":
    case "shellStreamArgs":
      return {
        frames: shellFrames(binding, parseBashOutcome(result)),
        closeStream: binding.execCase === "shellStreamArgs",
      };
  }
}

function readResultFrame(rawPath: string, result: ParsedToolResult): NativeExecFrame {
  if (result.isError) {
    return existsSync(resolvePath(rawPath))
      ? readFrame({
          case: "error",
          value: create(ReadErrorSchema, { path: rawPath, error: result.content }),
        })
      : readFrame({
          case: "fileNotFound",
          value: create(ReadFileNotFoundSchema, { path: rawPath }),
        });
  }
  // Cursor applies the model's offset/limit itself, so it needs the file rather than Pi's slice.
  return execRead({ path: rawPath }, { unconfined: true });
}

function writeSuccessFrame(binding: {
  path: string;
  fileText: string;
  returnFileContent: boolean;
}): NativeExecFrame {
  const absPath = resolvePath(binding.path);
  let fileSize = Buffer.byteLength(binding.fileText, "utf8");
  let contentAfter: string | undefined;
  try {
    fileSize = statSync(absPath).size;
    if (binding.returnFileContent) contentAfter = readFileSync(absPath, "utf8");
  } catch {
    // Pi reported success; fall back to the requested content for the summary.
  }
  return writeFrame({
    case: "success",
    value: create(WriteSuccessSchema, {
      path: binding.path,
      linesCreated: binding.fileText.length === 0 ? 0 : binding.fileText.split("\n").length,
      fileSize,
      ...(contentAfter !== undefined ? { fileContentAfterWrite: contentAfter } : {}),
    }),
  });
}

function deleteResultFrame(
  binding: { path: string; fileSize: number; prevContent: string },
  result: ParsedToolResult,
): NativeExecFrame {
  let error = result.isError ? result.content : undefined;
  if (!error) {
    try {
      lstatSync(resolvePath(binding.path));
      error = "The file still exists after rm.";
    } catch {
      // Gone, as requested.
    }
  }
  if (error) {
    return deleteFrame({
      case: "error",
      value: create(DeleteErrorSchema, { path: binding.path, error }),
    });
  }
  return deleteFrame({
    case: "success",
    value: create(DeleteSuccessSchema, {
      path: binding.path,
      deletedFile: binding.path,
      fileSize: BigInt(binding.fileSize),
      prevContent: binding.prevContent,
    }),
  });
}

function lsResultFrame(
  binding: { path: string; ignore: string[] },
  result: ParsedToolResult,
): NativeExecFrame {
  if (result.isError) {
    return lsFrame({
      case: "error",
      value: create(LsErrorSchema, { path: binding.path, error: result.content }),
    });
  }
  const absPath = resolvePath(binding.path);
  const ignore = binding.ignore.map(globToRegExp);
  const dirs: MessageShape<typeof LsDirectoryTreeNodeSchema>[] = [];
  const files: MessageShape<typeof LsDirectoryTreeNode_FileSchema>[] = [];
  for (const line of result.content.split("\n")) {
    if (!line || isToolNotice(line)) continue;
    const isDir = line.endsWith("/");
    const name = isDir ? line.slice(0, -1) : line;
    if (!name || name === "." || name === ".." || ignore.some((glob) => glob.test(name))) continue;
    if (isDir) {
      dirs.push(
        create(LsDirectoryTreeNodeSchema, {
          absPath: path.join(absPath, name),
          childrenWereProcessed: false,
        }),
      );
    } else {
      files.push(create(LsDirectoryTreeNode_FileSchema, { name }));
    }
  }
  return lsFrame({
    case: "success",
    value: create(LsSuccessSchema, {
      directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
        absPath,
        childrenDirs: dirs,
        childrenFiles: files,
        childrenWereProcessed: true,
        numFiles: files.length,
      }),
    }),
  });
}

function grepResultFrame(
  binding: { pattern: string; path: string; outputMode: GrepOutputMode; limit: number },
  result: ParsedToolResult,
): NativeExecFrame {
  // The pipeline status is head's, so an error here means the command never ran.
  if (result.isError) return grepErrorFrame(result.content);
  const lines = grepOutputLines(result.content);
  const truncated = lines.length >= binding.limit;
  const exists = cachedExists();
  let union: GrepUnionResult["result"] | undefined;

  if (binding.outputMode === "files_with_matches") {
    const files = lines.filter((line) => exists(line));
    if (files.length > 0 || lines.length === 0) {
      union = {
        case: "files",
        value: create(GrepFilesResultSchema, {
          files,
          totalFiles: files.length,
          clientTruncated: truncated,
          ripgrepTruncated: false,
        }),
      };
    }
  } else if (binding.outputMode === "count") {
    const counts = lines.flatMap((line) => {
      const match = /^(.*):(\d+)$/.exec(line);
      return match && exists(match[1]!) ? [{ file: match[1]!, count: Number(match[2]) }] : [];
    });
    if (counts.length > 0 || lines.length === 0) {
      union = {
        case: "count",
        value: create(GrepCountResultSchema, {
          counts: counts.map((entry) => create(GrepFileCountSchema, entry)),
          totalFiles: counts.length,
          totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
          clientTruncated: truncated,
          ripgrepTruncated: false,
        }),
      };
    }
  } else {
    const byFile = new Map<
      string,
      Array<{ lineNumber: number; content: string; isContextLine: boolean }>
    >();
    let parsedLines = 0;
    let matchedLines = 0;
    for (const line of lines) {
      if (line === "--") continue;
      const parsed = splitGrepLine(line, exists);
      if (!parsed) continue;
      parsedLines += 1;
      if (!parsed.isContextLine) matchedLines += 1;
      const entries = byFile.get(parsed.file) ?? [];
      entries.push(parsed);
      byFile.set(parsed.file, entries);
    }
    if (parsedLines > 0 || lines.length === 0) {
      union = {
        case: "content",
        value: create(GrepContentResultSchema, {
          matches: [...byFile].map(([file, entries]) =>
            create(GrepFileMatchSchema, {
              file,
              matches: entries.map((entry) =>
                create(GrepContentMatchSchema, {
                  lineNumber: entry.lineNumber,
                  content: entry.content,
                  contentTruncated: false,
                  isContextLine: entry.isContextLine,
                }),
              ),
            }),
          ),
          totalLines: parsedLines,
          totalMatchedLines: matchedLines,
          clientTruncated: truncated,
          ripgrepTruncated: false,
        }),
      };
    }
  }

  // Output that parses as no match at all is ripgrep's own error text.
  if (!union) return grepErrorFrame(lines.join("\n"));
  return {
    resultCase: "grepResult",
    value: create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, {
          pattern: binding.pattern,
          path: binding.path,
          outputMode: binding.outputMode,
          workspaceResults: { [process.cwd()]: create(GrepUnionResultSchema, { result: union }) },
        }),
      },
    }),
  };
}

type BashOutcome = {
  output: string;
  exitCode: number;
  outcome: "ok" | "exit" | "timeout" | "aborted" | "refused";
  timeoutSeconds?: number;
};

/** Splits Pi bash's text result into output and the status line Pi appends on failure. */
export function parseBashOutcome(result: ParsedToolResult): BashOutcome {
  const text = result.content ?? "";
  const clean = (output: string) => (output === "(no output)" ? "" : output);
  if (!result.isError) return { output: clean(text), exitCode: 0, outcome: "ok" };
  const status =
    /(?:^|\n\n)(?:Command exited with code (\d+)|Command timed out after (\d+) seconds|Command aborted|Command terminated without an exit code)$/.exec(
      text,
    );
  // No status line: Pi (or a hook) refused the call before the command ran.
  if (!status) return { output: text, exitCode: 1, outcome: "refused" };
  const output = clean(text.slice(0, status.index));
  if (status[1] !== undefined) return { output, exitCode: Number(status[1]), outcome: "exit" };
  if (status[2] !== undefined) {
    return { output, exitCode: 124, outcome: "timeout", timeoutSeconds: Number(status[2]) };
  }
  return { output, exitCode: 130, outcome: "aborted" };
}

function shellFrames(
  binding: {
    execCase: "shellArgs" | "shellStreamArgs";
    command: string;
    workingDirectory: string;
    startedAtMs: number;
  },
  outcome: BashOutcome,
): NativeExecFrame[] {
  const { command, workingDirectory } = binding;
  const rejected = () =>
    create(ShellRejectedSchema, {
      command,
      workingDirectory,
      reason: outcome.output,
      isReadonly: false,
    });

  if (binding.execCase === "shellStreamArgs") {
    const event = (value: MessageInitShape<typeof ShellStreamSchema>["event"]) => ({
      resultCase: "shellStream",
      value: create(ShellStreamSchema, { event: value }),
    });
    if (outcome.outcome === "refused") return [event({ case: "rejected", value: rejected() })];
    const frames: NativeExecFrame[] = [
      event({ case: "start", value: create(ShellStreamStartSchema, {}) }),
    ];
    if (outcome.output) {
      frames.push(
        event({ case: "stdout", value: create(ShellStreamStdoutSchema, { data: outcome.output }) }),
      );
    }
    frames.push(
      event({
        case: "exit",
        value: create(ShellStreamExitSchema, {
          code: outcome.exitCode,
          cwd: workingDirectory,
          aborted: outcome.outcome === "aborted" || outcome.outcome === "timeout",
        }),
      }),
    );
    return frames;
  }

  const executionTime = Math.max(0, Date.now() - binding.startedAtMs);
  const shellResult = (result: MessageInitShape<typeof ShellResultSchema>["result"]) => ({
    resultCase: "shellResult",
    value: create(ShellResultSchema, { result }),
  });
  switch (outcome.outcome) {
    case "ok":
      return [
        shellResult({
          case: "success",
          value: create(ShellSuccessSchema, {
            command,
            workingDirectory,
            exitCode: 0,
            stdout: outcome.output,
            stderr: "",
            executionTime,
            interleavedOutput: outcome.output,
          }),
        }),
      ];
    case "timeout":
      return [
        shellResult({
          case: "timeout",
          value: create(ShellTimeoutSchema, {
            command,
            workingDirectory,
            timeoutMs: (outcome.timeoutSeconds ?? 0) * 1000,
          }),
        }),
      ];
    case "refused":
      return [shellResult({ case: "rejected", value: rejected() })];
    default:
      return [
        shellResult({
          case: "failure",
          value: create(ShellFailureSchema, {
            command,
            workingDirectory,
            exitCode: outcome.exitCode,
            stdout: outcome.output,
            stderr: "",
            executionTime,
            interleavedOutput: outcome.output,
            aborted: outcome.outcome === "aborted",
          }),
        }),
      ];
  }
}

function rejectionFrames(
  execCase: string,
  args: Record<string, unknown>,
  reason: string,
): NativeExecFrame[] {
  const rawPath = str(args.path);
  switch (execCase) {
    case "readArgs":
      return [
        readFrame({
          case: "rejected",
          value: create(ReadRejectedSchema, { path: rawPath, reason }),
        }),
      ];
    case "writeArgs":
      return [
        writeFrame({
          case: "rejected",
          value: create(WriteRejectedSchema, { path: rawPath, reason }),
        }),
      ];
    case "deleteArgs":
      return [
        deleteFrame({
          case: "rejected",
          value: create(DeleteRejectedSchema, { path: rawPath, reason }),
        }),
      ];
    case "lsArgs":
      return [
        lsFrame({ case: "rejected", value: create(LsRejectedSchema, { path: rawPath, reason }) }),
      ];
    case "shellArgs":
    case "shellStreamArgs":
      return shellFrames(
        {
          execCase,
          command: str(args.command),
          workingDirectory: str(args.workingDirectory),
          startedAtMs: Date.now(),
        },
        { output: reason, exitCode: 1, outcome: "refused" },
      );
    default:
      return [grepErrorFrame(reason)];
  }
}

// ── Edit hunks ──

function splitLinesKeepingEndings(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function occursOnce(haystack: string, needle: string): boolean {
  const first = haystack.indexOf(needle);
  return first !== -1 && haystack.indexOf(needle, first + 1) === -1;
}

/**
 * The smallest single `edit` replacement that turns `before` into `after`,
 * widened by unchanged context until its `oldText` is unique in `before`.
 * Returns null when a Pi `write` is the better representation.
 */
export function computeReplaceEdits(
  before: string,
  after: string,
): Array<{ oldText: string; newText: string }> | null {
  // Pi's edit strips a BOM before matching; it cannot target one.
  if (before.startsWith("\uFEFF") || after.startsWith("\uFEFF")) return null;
  const oldText = before.replace(/\r\n?/g, "\n");
  const newText = after.replace(/\r\n?/g, "\n");
  if (oldText === newText) return null;
  const oldLines = splitLinesKeepingEndings(oldText);
  const newLines = splitLinesKeepingEndings(newText);

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (
    oldLines.length >= REWRITE_MIN_LINES &&
    oldEnd - start > oldLines.length * REWRITE_CHANGED_LINE_RATIO
  ) {
    return null;
  }

  const edit = (contextBefore: number, contextAfter: number) => {
    const from = start - contextBefore;
    const candidate = oldLines.slice(from, oldEnd + contextAfter).join("");
    return candidate.length > 0 && occursOnce(oldText, candidate)
      ? [{ oldText: candidate, newText: newLines.slice(from, newEnd + contextAfter).join("") }]
      : undefined;
  };
  let contextBefore = 0;
  let contextAfter = 0;
  for (;;) {
    const found = edit(contextBefore, contextAfter);
    if (found) return found;
    const canWidenBefore = start - contextBefore > 0;
    const canWidenAfter = oldEnd + contextAfter < oldLines.length;
    if (!canWidenBefore && !canWidenAfter) return null;
    if (contextBefore + contextAfter >= MAX_EDIT_CONTEXT_LINES) return null;
    const oneSided =
      (canWidenBefore ? edit(contextBefore + 1, contextAfter) : undefined) ??
      (canWidenAfter ? edit(contextBefore, contextAfter + 1) : undefined);
    if (oneSided) return oneSided;
    if (canWidenBefore) contextBefore += 1;
    if (canWidenAfter) contextAfter += 1;
  }
}

// ── Helpers ──

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolvePath(rawPath: string): string {
  return path.resolve(process.cwd(), rawPath || ".");
}

/** Relative paths read better in Pi's transcript; paths outside the cwd stay absolute. */
function piPath(rawPath: string): string {
  const absPath = resolvePath(rawPath);
  const relative = path.relative(process.cwd(), absPath);
  if (!relative) return ".";
  const outside =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? absPath : relative;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArg(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : shellQuote(value);
}

function piShellCommand(command: string, workingDirectory: string, background: boolean): string {
  let script = command;
  if (background) {
    const log = path.join(tmpdir(), `pi-cursor-bg-${randomUUID().slice(0, 8)}.log`);
    script =
      `nohup bash -c ${shellQuote(command)} > ${shellArg(log)} 2>&1 < /dev/null &\n` +
      `echo "Started in background (pid $!). Output: ${log}"`;
  }
  if (workingDirectory === path.resolve(process.cwd())) return script;
  return `cd ${shellArg(piPath(workingDirectory))} && {\n${script}\n}`;
}

function grepOutputMode(value: unknown): GrepOutputMode {
  return value === "files_with_matches" || value === "count" ? value : "content";
}

function ripgrepCommand(
  args: Record<string, unknown>,
  pattern: string,
  target: string,
  outputMode: GrepOutputMode,
  limit: number,
): string {
  const parts = ["rg", "--color=never", "--no-heading", "--with-filename"];
  if (outputMode === "files_with_matches") {
    parts.push("--files-with-matches");
  } else if (outputMode === "count") {
    parts.push("--count");
  } else {
    parts.push("--line-number");
    const context = positiveInt(args.context);
    const contextBefore = positiveInt(args.contextBefore);
    const contextAfter = positiveInt(args.contextAfter);
    if (context) parts.push("-C", String(context));
    if (!context && contextBefore) parts.push("-B", String(contextBefore));
    if (!context && contextAfter) parts.push("-A", String(contextAfter));
    parts.push("--max-columns=500", "--max-columns-preview");
  }
  if (args.caseInsensitive === true) parts.push("-i");
  if (args.multiline === true) parts.push("-U", "--multiline-dotall");
  if (str(args.glob)) parts.push("-g", shellArg(str(args.glob)));
  if (str(args.type)) parts.push("-t", shellArg(str(args.type)));
  parts.push("-e", shellArg(pattern));
  if (target !== ".") parts.push("--", shellArg(target));
  return `${parts.join(" ")} | head -n ${limit}`;
}

function isToolNotice(line: string): boolean {
  return /^\[.*\]$/.test(line) || line === "(empty directory)" || line === "(no output)";
}

/** Output lines of a grep run, reading Pi's full-output file when its display was truncated. */
function grepOutputLines(content: string): string[] {
  const fullOutput = /\n*\[Showing lines [^\]]*Full output: ([^\]]+)\]$/.exec(content);
  let text = content;
  if (fullOutput) {
    try {
      text = readFileSync(fullOutput[1]!, "utf8");
    } catch {
      text = content.slice(0, fullOutput.index);
    }
  }
  return text.split("\n").filter((line) => line.length > 0 && !isToolNotice(line));
}

function cachedExists(): (file: string) => boolean {
  const cache = new Map<string, boolean>();
  return (file) => {
    let found = cache.get(file);
    if (found === undefined) {
      found = file.length > 0 && existsSync(resolvePath(file));
      cache.set(file, found);
    }
    return found;
  };
}

/**
 * ripgrep prints `path:line:text` for matches and `path-line-text` for context.
 * Both separators can occur in file names, so the split is confirmed on disk.
 */
function splitGrepLine(
  line: string,
  exists: (file: string) => boolean,
): { file: string; lineNumber: number; content: string; isContextLine: boolean } | undefined {
  const separator = /([:-])(\d+)\1/g;
  for (let match = separator.exec(line); match; match = separator.exec(line)) {
    const file = line.slice(0, match.index);
    if (exists(file)) {
      return {
        file,
        lineNumber: Number(match[2]),
        content: line.slice(match.index + match[0].length),
        isContextLine: match[1] === "-",
      };
    }
    separator.lastIndex = match.index + 1;
  }
  return undefined;
}

function globToRegExp(glob: string): RegExp {
  const trimmed = glob.replace(/^\*\*\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === "*") {
      const double = trimmed[i + 1] === "*";
      source += double ? ".*" : "[^/]*";
      if (double) i += 1;
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function writeText(args: Record<string, unknown>): string | undefined {
  const bytes = args.fileBytes;
  if (bytes instanceof Uint8Array && bytes.byteLength > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  return str(args.fileText);
}

/** File text, null when absent, undefined when it is not a readable regular file. */
function readTextFile(absPath: string): string | null | undefined {
  try {
    if (!statSync(absPath).isFile()) return undefined;
    return readFileSync(absPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined;
  }
}

function readTextPrefix(absPath: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Text Cursor received from a native read; null for a missing file, undefined otherwise. */
function readFrameText(frame: NativeExecFrame): string | null | undefined {
  const result = (frame.value as { result?: { case?: string; value?: any } })?.result;
  if (result?.case === "fileNotFound") return null;
  if (result?.case !== "success") return undefined;
  const output = result.value?.output;
  return output?.case === "content" && typeof output.value === "string" ? output.value : undefined;
}

function readFrame(result: MessageInitShape<typeof ReadResultSchema>["result"]): NativeExecFrame {
  return { resultCase: "readResult", value: create(ReadResultSchema, { result }) };
}

function writeFrame(result: MessageInitShape<typeof WriteResultSchema>["result"]): NativeExecFrame {
  return { resultCase: "writeResult", value: create(WriteResultSchema, { result }) };
}

function deleteFrame(
  result: MessageInitShape<typeof DeleteResultSchema>["result"],
): NativeExecFrame {
  return { resultCase: "deleteResult", value: create(DeleteResultSchema, { result }) };
}

function lsFrame(result: MessageInitShape<typeof LsResultSchema>["result"]): NativeExecFrame {
  return { resultCase: "lsResult", value: create(LsResultSchema, { result }) };
}

function grepErrorFrame(error: string): NativeExecFrame {
  return {
    resultCase: "grepResult",
    value: create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error }) },
    }),
  };
}
