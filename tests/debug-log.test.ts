import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setBridgeFactoryForTests } from "../src/stream/bridge-session.js";
import { emitMetric } from "../src/stream/debug-log.js";
import { discoverCursorCatalog } from "../src/stream/model-discovery.js";

function spyOnTerminal() {
  return [
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    ...(["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    ),
  ];
}

function readLogEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("diagnostics stay off the terminal", () => {
  let dir: string;
  let logPath: string;
  let terminal: ReturnType<typeof spyOnTerminal>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-debug-log-"));
    logPath = join(dir, "lifecycle.jsonl");
    vi.stubEnv("PI_CURSOR_LIFECYCLE_LOG", logPath);
    terminal = spyOnTerminal();
  });

  afterEach(() => {
    setBridgeFactoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes metrics to the lifecycle log", async () => {
    emitMetric("metric.cursor_provider.rebuild_full_history", {
      metric: "cursor_provider.rebuild_full_history",
      reason: "synthesized_after_idle",
      count: 1,
    });

    await vi.waitFor(() =>
      expect(readLogEntries(logPath)).toContainEqual(
        expect.objectContaining({
          event: "metric.cursor_provider.rebuild_full_history",
          reason: "synthesized_after_idle",
        }),
      ),
    );
    for (const spy of terminal) expect(spy).not.toHaveBeenCalled();
  });

  it("writes model discovery failures to the lifecycle log", async () => {
    vi.stubEnv("PI_CURSOR_UNARY_BRIDGE", "1");
    setBridgeFactoryForTests(() => {
      throw new Error("connect failed");
    });

    await expect(discoverCursorCatalog("debug-log-test-token")).resolves.toEqual({
      rawModels: [],
      parameterizedModels: [],
    });

    await vi.waitFor(() =>
      expect(readLogEntries(logPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "model_discovery_failed", message: "connect failed" }),
          expect.objectContaining({ event: "model_discovery_empty" }),
          expect.objectContaining({
            event: "parameterized_model_discovery_failed",
            message: "connect failed",
          }),
        ]),
      ),
    );
    for (const spy of terminal) expect(spy).not.toHaveBeenCalled();
  });
});
