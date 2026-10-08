// `ka sync`'s progress line (issue #2): plain throttled lines into a log, a line
// redrawn in place on a terminal, and the arithmetic of rate and time left.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EVERY_MS, EVERY_REFS, RECENT_MS, SyncProgress, duration } from "../src/progress.js";
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

  it("takes the rate and the time left from the last ten minutes, beside the average once they part", () => {
    // Issue #14: Berlin 2026 went from 64/min to 17/min and the line kept "~31 min left".
    const { io: sink, lines } = io(false);
    const time = clock();
    const progress = new SyncProgress(sink, time.now);
    progress.discovered("berlin", 2000);
    for (let i = 1; i <= 600; i++) {
      time.advance(1_000); // 60/min for ten minutes
      progress.update("berlin", event(i, 2000));
    }
    strictEqual(lines.at(-1), "berlin: 600/2000 · 0 failed · 60/min · ~23 min left");
    for (let i = 601; i <= 700; i++) {
      time.advance(6_000); // then 10/min for ten minutes
      progress.update("berlin", event(i, 2000));
    }
    // The recent window is all slow now; the average is still 35/min.
    strictEqual(lines.at(-1), "berlin: 700/2000 · 0 failed · 10/min now (35/min avg) · ~2h 09m left");
    strictEqual(RECENT_MS, 600_000);
  });

  it("says where the time goes: upstream per request, waiting, extraction, retries and throttling", () => {
    const { io: sink, lines } = io(false);
    const time = clock();
    const progress = new SyncProgress(sink, time.now);
    progress.discovered("sachsen-anhalt", 25);
    const timing = {
      elapsedMs: 100_000,
      requests: 75,
      retries: 3,
      throttled: 2,
      retryReasons: { throttled: 2, timeout: 0, connection: 1, other: 0 },
      reconnects: 4,
      upstreamMsAvg: 4100,
      upstreamMsP95: 9000,
      waitMs: 40_000,
      extractMs: 5_000,
      storeMs: 1_000,
    };
    for (let i = 1; i <= 25; i++) {
      time.advance(4_000);
      progress.update("sachsen-anhalt", { ...event(i, 25), timing });
    }
    strictEqual(
      lines.at(-1),
      "sachsen-anhalt: 25/25 · 0 failed · 15/min · done in 2 min · upstream 4.1 s/req · waiting 40% · extract 0.2 s · retries 3 (2 throttled, 1 connection) · reconnected 4 · throttled 2×",
    );
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
