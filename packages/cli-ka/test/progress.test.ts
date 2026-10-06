// `ka sync`'s progress line (issue #2): plain throttled lines into a log, a line
// redrawn in place on a terminal, and the arithmetic of rate and time left.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EVERY_MS, EVERY_REFS, SyncProgress, duration } from "../src/progress.js";
import type { CliIO } from "../src/io.js";

function io(terminal: boolean): { io: CliIO; lines: string[]; raw: string[] } {
  const lines: string[] = [];
  const raw: string[] = [];
  return {
    lines,
    raw,
    io: {
      out: () => undefined,
      err: (text) => lines.push(text),
      writeFile: () => undefined,
      ...(terminal ? { errIsTerminal: true, errPartial: (text: string) => raw.push(text) } : {}),
    },
  };
}

/** A clock the test moves by hand. */
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let at = Date.parse("2026-10-06T10:00:00Z");
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

const event = (index: number, total: number, action: "stored" | "failed" = "stored") => ({
  index,
  total,
  id: `19/${index}`,
  action,
  ...(action === "failed" ? { detail: "HTTP 500" } : {}),
});

describe("sync progress", () => {
  it("prints plain lines every EVERY_REFS Anfragen into a log, with rate and time left", () => {
    const { io: sink, lines } = io(false);
    const time = clock();
    const progress = new SyncProgress(sink, time.now);
    progress.start("berlin");
    progress.discovered("berlin", 60);
    for (let i = 1; i <= 60; i++) {
      time.advance(1_000);
      progress.update("berlin", event(i, 60, i === 7 ? "failed" : "stored"));
    }
    progress.finish("berlin");
    deepStrictEqual(lines, [
      "berlin: 60 Anfragen discovered",
      "  ! berlin 19/7: HTTP 500",
      `berlin: ${EVERY_REFS}/60 · 1 failed · 60/min · ~35s left`,
      "berlin: 50/60 · 1 failed · 60/min · ~10s left",
      "berlin: 60/60 · 1 failed · 60/min · done in 1 min",
    ]);
  });

  it("prints a line after EVERY_MS even when few Anfragen were handled", () => {
    const { io: sink, lines } = io(false);
    const time = clock();
    const progress = new SyncProgress(sink, time.now);
    progress.discovered("bund", 1000);
    time.advance(EVERY_MS);
    progress.update("bund", event(EVERY_REFS, 1000));
    time.advance(EVERY_MS);
    progress.update("bund", event(EVERY_REFS + 1, 1000));
    strictEqual(lines.length, 3);
    strictEqual(lines[2], "bund: 26/1000 · 0 failed · 26/min · ~37 min left");
  });

  it("redraws one line in place on a terminal, one segment per running source", () => {
    const { io: sink, lines, raw } = io(true);
    const time = clock();
    const progress = new SyncProgress(sink, time.now);
    progress.start("berlin");
    progress.start("bund");
    strictEqual(raw.at(-1), "\r\u001b[Kberlin: discovering…  |  bund: discovering…");
    progress.discovered("berlin", 2);
    time.advance(30_000);
    progress.update("berlin", event(1, 2, "failed"));
    // The failure stays on screen; the status line is cleared first and redrawn after.
    deepStrictEqual(lines, ["  ! berlin 19/1: HTTP 500"]);
    strictEqual(raw.at(-1), "\r\u001b[Kberlin: 1/2 · 1 failed · 2.0/min · ~30s left  |  bund: discovering…");
    time.advance(30_000);
    progress.update("berlin", event(2, 2));
    progress.finish("berlin");
    strictEqual(lines.at(-1), "berlin: 2/2 · 1 failed · 2.0/min · done in 1 min");
    strictEqual(raw.at(-1), "\r\u001b[Kbund: discovering…");
    progress.close();
    strictEqual(raw.at(-1), "\r\u001b[K", "the status line is cleared before the summary");
    ok(!lines.some((line) => line.includes("\r")), "plain lines never carry a carriage return");
  });

  it("leaves out rate and time left until time has passed", () => {
    const { io: sink, lines } = io(false);
    const progress = new SyncProgress(sink, () => new Date(0));
    progress.discovered("berlin", 1);
    progress.update("berlin", event(1, 1));
    strictEqual(lines.at(-1), "berlin: 1/1 · 0 failed");
  });

  it("writes durations for people", () => {
    deepStrictEqual([duration(0), duration(59_000), duration(60_000), duration(3_599_000), duration(18_300_000)], [
      "0s",
      "59s",
      "1 min",
      "1h 00m",
      "5h 05m",
    ]);
  });
});
