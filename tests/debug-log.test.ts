import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitMetric } from "../src/stream/debug-log.js";

describe("emitMetric default sink", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-debug-log-"));
    logPath = join(dir, "lifecycle.jsonl");
    vi.stubEnv("PI_CURSOR_LIFECYCLE_LOG", logPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes to the lifecycle log and never to the terminal", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    emitMetric("metric.cursor_provider.rebuild_full_history", {
      metric: "cursor_provider.rebuild_full_history",
      reason: "synthesized_after_idle",
      count: 1,
    });

    await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: "metric.cursor_provider.rebuild_full_history",
      reason: "synthesized_after_idle",
    });
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
