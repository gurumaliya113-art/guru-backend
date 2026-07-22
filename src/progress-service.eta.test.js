// Property-based tests for Progress_Service ETA behavior (task 2.5).
//
// These target the "Derived-value rules" ETA section of the design and
// correctness Properties 7, 8, and 9. They exercise `computeMetrics` directly by
// constructing a JobState via `createJobState` and pushing known values into
// `job.completed` and `job.durationsMs` — this makes the pure ETA math fully
// deterministic (no wall-clock involved), which is exactly what these rules are
// about. A single fake-timer integration check drives the real
// startPage/completePage path to confirm measured durations flow through.
//
// Framework: Vitest + fast-check (per the design's Testing Strategy).

import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import {
  createJobState,
  computeMetrics,
  createJob,
  startPage,
  completePage,
  getJob,
  disposeJob,
} from "./progress-service.js";

const MAX_PAGES = 200;
const MAX_DURATION_MS = 600_000; // up to 10 minutes per page

/**
 * Build a JobState with `totalPages`, `completedCount` distinct completed pages
 * (1..completedCount), and an explicit durations array. Mirrors how the service
 * accumulates state so `computeMetrics` sees a realistic job.
 */
function buildJob(totalPages, completedCount, durationsMs) {
  const job = createJobState("job-under-test", totalPages);
  for (let p = 1; p <= completedCount; p++) {
    job.completed.add(p);
  }
  job.durationsMs = [...durationsMs];
  return job;
}

/** Average that includes zero-duration entries (matches the ETA rule). */
function average(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const d of arr) sum += d;
  return sum / arr.length;
}

/**
 * Generator: a random totalPages (0..MAX_PAGES), a random completedCount in
 * [0, totalPages], and a durations array sized to completedCount whose entries
 * include zeros (fc.integer 0..MAX_DURATION_MS).
 */
const jobArb = fc.nat({ max: MAX_PAGES }).chain((totalPages) =>
  fc.integer({ min: 0, max: totalPages }).chain((completedCount) =>
    fc
      .array(fc.integer({ min: 0, max: MAX_DURATION_MS }), {
        minLength: completedCount,
        maxLength: completedCount,
      })
      .map((durationsMs) => ({ totalPages, completedCount, durationsMs }))
  )
);

/**
 * Generator for the "partial" case where completedCount > 0 AND remainingCount > 0:
 * totalPages >= 2, completedCount in [1, totalPages - 1].
 */
const partialJobArb = fc.integer({ min: 2, max: MAX_PAGES }).chain((totalPages) =>
  fc.integer({ min: 1, max: totalPages - 1 }).chain((completedCount) =>
    fc
      .array(fc.integer({ min: 0, max: MAX_DURATION_MS }), {
        minLength: completedCount,
        maxLength: completedCount,
      })
      .map((durationsMs) => ({ totalPages, completedCount, durationsMs }))
  )
);

describe("Progress_Service ETA properties", () => {
  // Property 7: ETA availability. Validates: Requirements 5.3
  it("Property 7: etaSeconds === null iff (completedCount === 0 && totalPages > 0)", () => {
    fc.assert(
      fc.property(jobArb, ({ totalPages, completedCount, durationsMs }) => {
        const job = buildJob(totalPages, completedCount, durationsMs);
        const m = computeMetrics(job);
        const expectedNull = completedCount === 0 && totalPages > 0;
        expect(m.etaSeconds === null).toBe(expectedNull);
      })
    );
  });

  // Property 8: ETA zero at end. Validates: Requirements 5.4
  it("Property 8: remainingCount === 0 implies etaSeconds === 0", () => {
    fc.assert(
      fc.property(jobArb, ({ totalPages, completedCount, durationsMs }) => {
        const job = buildJob(totalPages, completedCount, durationsMs);
        const m = computeMetrics(job);
        if (m.remainingCount === 0) {
          expect(m.etaSeconds).toBe(0);
        }
      })
    );
  });

  // Property 9: ETA from measured durations. Validates: Requirements 5.1, 5.2
  it("Property 9: when completedCount>0 && remainingCount>0, etaSeconds === average(durationsMs)*remainingCount/1000 (zeros included)", () => {
    fc.assert(
      fc.property(partialJobArb, ({ totalPages, completedCount, durationsMs }) => {
        const job = buildJob(totalPages, completedCount, durationsMs);
        const m = computeMetrics(job);

        // Precondition of the property.
        expect(m.completedCount).toBeGreaterThan(0);
        expect(m.remainingCount).toBeGreaterThan(0);

        const expected = (average(durationsMs) * m.remainingCount) / 1000;
        // Floating-point tolerant comparison (relative tolerance for large ETAs).
        const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
        expect(Math.abs(m.etaSeconds - expected)).toBeLessThanOrEqual(tolerance);
      })
    );
  });

  // Concrete example from the design's ETA rule / Testing Strategy.
  it("example: durations [0, 10000ms, 20000ms] (avg 10000ms) with remainingCount 2 gives etaSeconds 20", () => {
    // totalPages 5, 3 pages done -> 2 remaining.
    const job = buildJob(5, 3, [0, 10000, 20000]);
    const m = computeMetrics(job);
    expect(m.completedCount).toBe(3);
    expect(m.remainingCount).toBe(2);
    expect(m.etaSeconds).toBe(20);
  });
});

describe("Progress_Service ETA integration (measured durations via fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives startPage/completePage with controlled wall-clock and yields the expected ETA", () => {
    vi.useFakeTimers();
    const jobId = "integration-eta";
    try {
      vi.setSystemTime(0);
      createJob(jobId, { totalPages: 5 });

      // Page 1: 0ms duration.
      startPage(jobId, 1);
      completePage(jobId, 1, {});

      // Page 2: 10000ms duration.
      startPage(jobId, 2); // recorded at t=0
      vi.setSystemTime(10_000);
      completePage(jobId, 2, {});

      // Page 3: 20000ms duration.
      startPage(jobId, 3); // recorded at t=10000
      vi.setSystemTime(30_000);
      completePage(jobId, 3, {});

      const job = getJob(jobId);
      expect(job.durationsMs).toEqual([0, 10_000, 20_000]);

      const m = computeMetrics(job);
      expect(m.completedCount).toBe(3);
      expect(m.remainingCount).toBe(2);
      // average(0,10000,20000)=10000ms; 10000ms * 2 / 1000 = 20s.
      expect(m.etaSeconds).toBe(20);
    } finally {
      disposeJob(jobId);
    }
  });
});
