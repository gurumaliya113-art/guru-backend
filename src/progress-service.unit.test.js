// Unit + property tests for the Progress_Service (task 2.6).
//
// Covers the terminal transitions, zero-page completion, replay ordering,
// idempotency, and ETA math described in the design's "Testing Strategy >
// Unit testing", plus the two named correctness properties assigned to this
// task:
//   - Property 10: Total-first ordering       (Validates: Requirements 1.3)
//   - Property 11: Terminal completion values  (Validates: Requirements 4.5, 4.6)
//
// The sibling files progress-service.properties.test.js (Properties 1-9 core
// metric invariants) and progress-service.eta.test.js (ETA properties) are
// owned by tasks 2.4 / 2.5 and are intentionally not touched here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import {
  registry,
  createJob,
  startPage,
  completePage,
  completeJob,
  stopJob,
  failJob,
  subscribe,
  createJobState,
  computeMetrics,
} from "./progress-service.js";

// Each test uses a unique jobId, and we clear the registry between tests, so no
// state (or pending auto-dispose timer) bleeds across cases.
let idCounter = 0;
function freshId() {
  idCounter += 1;
  return `job-${idCounter}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
  registry.clear();
});

afterEach(() => {
  registry.clear();
});

/**
 * Attach a subscriber that records every event it observes into an array, and
 * return that array. Replayed (buffered) events land in the array in order,
 * followed by any live events.
 */
function record(jobId) {
  const received = [];
  subscribe(jobId, (e) => received.push(e));
  return received;
}

describe("Property 10: Total-first ordering (Validates: Requirements 1.3)", () => {
  it("(a) a subscriber attached BEFORE createJob observes `total` before any `progress`", () => {
    const jobId = freshId();

    // Attach early: creates a pending placeholder, no `total` emitted yet.
    const received = record(jobId);
    expect(received).toHaveLength(0);

    // Now register the job and complete a page — events arrive live.
    createJob(jobId, { totalPages: 3 });
    startPage(jobId, 1);
    completePage(jobId, 1);

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].type).toBe("total");
    // The first non-total event is a progress event that comes strictly after.
    const firstProgressIndex = received.findIndex((e) => e.type === "progress");
    expect(firstProgressIndex).toBeGreaterThan(0);
  });

  it("(b) a subscriber attached AFTER several completePage calls replays `total` first", () => {
    const jobId = freshId();

    createJob(jobId, { totalPages: 4 });
    startPage(jobId, 1);
    completePage(jobId, 1);
    startPage(jobId, 2);
    completePage(jobId, 2);

    // Late subscriber: replay must begin with the `total` event.
    const received = record(jobId);
    expect(received[0].type).toBe("total");
    // Every `progress` event in the replay comes after the leading `total`.
    for (let i = 1; i < received.length; i++) {
      expect(received[i].type).toBe("progress");
    }
  });

  it("holds for randomized total-first ordering across arbitrary jobs (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        // A subset of pages to complete, and whether to subscribe early or late.
        fc.array(fc.integer({ min: 1, max: 20 }), { maxLength: 20 }),
        fc.boolean(),
        (totalPages, rawPages, subscribeEarly) => {
          const jobId = freshId();
          registry.delete(jobId);

          const pages = [...new Set(rawPages)].filter(
            (p) => p >= 1 && p <= totalPages
          );

          let received;
          if (subscribeEarly) {
            received = record(jobId);
            createJob(jobId, { totalPages });
            for (const p of pages) {
              startPage(jobId, p);
              completePage(jobId, p);
            }
          } else {
            createJob(jobId, { totalPages });
            for (const p of pages) {
              startPage(jobId, p);
              completePage(jobId, p);
            }
            received = record(jobId);
          }

          // The very first observed event is always `total`, and it precedes
          // every `progress` event.
          expect(received[0].type).toBe("total");
          const firstProgress = received.findIndex((e) => e.type === "progress");
          if (firstProgress !== -1) {
            expect(firstProgress).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("Property 11: Terminal completion values (Validates: Requirements 4.5, 4.6)", () => {
  it("completeJob yields completedCount === totalPages and percentage === 100", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 7 });
    completeJob(jobId);

    const complete = received.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    expect(complete.completedCount).toBe(7);
    expect(complete.totalPages).toBe(7);
    expect(complete.remainingCount).toBe(0);
    expect(complete.percentage).toBe(100);
    expect(complete.etaSeconds).toBe(0);
  });

  it("zero-page completeJob yields 0/0/100 with etaSeconds 0", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 0 });
    completeJob(jobId);

    const complete = received.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    expect(complete.completedCount).toBe(0);
    expect(complete.remainingCount).toBe(0);
    expect(complete.percentage).toBe(100);
    expect(complete.etaSeconds).toBe(0);
  });

  it("holds for randomized totalPages (fast-check)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (totalPages) => {
        const jobId = freshId();
        registry.delete(jobId);
        const received = record(jobId);

        createJob(jobId, { totalPages });
        completeJob(jobId);

        const complete = received.find((e) => e.type === "complete");
        expect(complete).toBeDefined();
        expect(complete.completedCount).toBe(totalPages);
        expect(complete.remainingCount).toBe(0);
        expect(complete.percentage).toBe(100);
        expect(complete.etaSeconds).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});

describe("stopJob terminal event", () => {
  it("emits a `stopped` event with completedCount < totalPages and a reason message", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 10 });
    startPage(jobId, 1);
    completePage(jobId, 1);
    startPage(jobId, 2);
    completePage(jobId, 2);
    stopJob(jobId, { reason: "Time budget exceeded" });

    const stopped = received.find((e) => e.type === "stopped");
    expect(stopped).toBeDefined();
    expect(stopped.completedCount).toBe(2);
    expect(stopped.completedCount).toBeLessThan(stopped.totalPages);
    expect(stopped.message).toBe("Time budget exceeded");
  });
});

describe("failJob terminal event", () => {
  it("emits a `failure` with the message and NO per-page progress events before it", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 5 });
    // No pages completed.
    failJob(jobId, { message: "File is password protected" });

    // Exactly the total event then the failure event — nothing in between.
    expect(received.map((e) => e.type)).toEqual(["total", "failure"]);
    const failure = received.find((e) => e.type === "failure");
    expect(failure.message).toBe("File is password protected");
    expect(received.some((e) => e.type === "progress")).toBe(false);
  });
});

describe("Replay after several completePage calls", () => {
  it("delivers the full ordered buffer, then continues with live events", () => {
    const jobId = freshId();

    createJob(jobId, { totalPages: 5 });
    for (const p of [1, 2, 3]) {
      startPage(jobId, p);
      completePage(jobId, p);
    }

    // Late subscriber replays total + 3 progress in order.
    const received = record(jobId);
    expect(received.map((e) => e.type)).toEqual([
      "total",
      "progress",
      "progress",
      "progress",
    ]);
    expect(received.map((e) => e.page?.number)).toEqual([
      undefined,
      1,
      2,
      3,
    ]);

    // Live events continue to arrive after replay.
    startPage(jobId, 4);
    completePage(jobId, 4);
    expect(received.map((e) => e.type)).toEqual([
      "total",
      "progress",
      "progress",
      "progress",
      "progress",
    ]);
    expect(received[4].page.number).toBe(4);
  });
});

describe("completePage idempotency and bounds", () => {
  it("completing the same page twice does not increase completedCount and emits one progress event", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 3 });
    startPage(jobId, 1);
    completePage(jobId, 1);
    // Second completion of the same page is a no-op.
    completePage(jobId, 1);

    const progressEvents = received.filter((e) => e.type === "progress");
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].completedCount).toBe(1);
    expect(registry.get(jobId).completed.size).toBe(1);
  });

  it("ignores out-of-range page numbers (< 1 or > totalPages)", () => {
    const jobId = freshId();
    const received = record(jobId);

    createJob(jobId, { totalPages: 3 });
    completePage(jobId, 0); // below range
    completePage(jobId, -1); // below range
    completePage(jobId, 4); // above range
    completePage(jobId, 99); // above range

    expect(received.some((e) => e.type === "progress")).toBe(false);
    expect(registry.get(jobId).completed.size).toBe(0);
  });
});

describe("ETA math example", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 5-page job completing 3 pages with average 10s and remaining 2 yields etaSeconds === 20", () => {
    vi.useFakeTimers();
    const base = 1_000_000;
    vi.setSystemTime(base);

    const jobId = freshId();
    const received = record(jobId);
    createJob(jobId, { totalPages: 5 });

    // Page 1: duration 0ms.
    startPage(jobId, 1);
    completePage(jobId, 1);

    // Page 2: duration 10s.
    startPage(jobId, 2);
    vi.setSystemTime(base + 10_000);
    completePage(jobId, 2);

    // Page 3: duration 20s (started at +10s, finished at +30s).
    startPage(jobId, 3);
    vi.setSystemTime(base + 30_000);
    completePage(jobId, 3);

    const lastProgress = received.filter((e) => e.type === "progress").at(-1);
    // durations [0, 10000, 20000] -> average 10000ms; remaining 2 -> 20s.
    expect(lastProgress.completedCount).toBe(3);
    expect(lastProgress.remainingCount).toBe(2);
    expect(lastProgress.etaSeconds).toBe(20);
  });

  it("fallback: computeMetrics on a constructed state gives the same result", () => {
    // Direct-construction fallback that does not rely on timers.
    const job = createJobState(freshId(), 5);
    job.completed.add(1);
    job.completed.add(2);
    job.completed.add(3);
    job.durationsMs.push(0, 10_000, 20_000);

    const metrics = computeMetrics(job);
    expect(metrics.completedCount).toBe(3);
    expect(metrics.remainingCount).toBe(2);
    expect(metrics.etaSeconds).toBe(20);
  });
});
