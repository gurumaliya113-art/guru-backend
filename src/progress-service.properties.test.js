// Property-based tests for Progress_Service (task 2.4).
//
// These tests exercise the correctness invariants of the progress metrics across
// arbitrary page-completion sequences, using fast-check. Each generated scenario:
//   1. subscribes a recording callback BEFORE the job is created (so the initial
//      `total` event is captured live in order),
//   2. creates the job with a random totalPages (including some 0 cases),
//   3. completes a random subset/permutation of pages (mix of failed true/false),
//   4. optionally emits a terminal `complete` event.
//
// Every emitted event for the job is collected and each property is asserted over
// the full event stream. A unique jobId is used per run and the registry is
// cleared between runs to avoid state bleed.

import { describe, it, afterEach, expect } from "vitest";
import fc from "fast-check";

import {
  registry,
  subscribe,
  createJob,
  startPage,
  completePage,
  completeJob,
  computeMetrics,
  getJob,
} from "./progress-service.js";

// Unique jobId generator so runs never collide.
let jobCounter = 0;
function nextJobId() {
  jobCounter += 1;
  return `pbt-job-${jobCounter}`;
}

// Clear all job state between property runs to prevent bleed.
afterEach(() => {
  registry.clear();
});

/**
 * Run one generated scenario end-to-end and return the ordered list of every
 * event the subscriber observed.
 *
 * @param {{ totalPages: number, order: number[], failedFlags: boolean[], doComplete: boolean }} scenario
 * @returns {import("./progress-service.js").ProgressEvent[]}
 */
function runScenario({ totalPages, order, failedFlags, doComplete }) {
  const jobId = nextJobId();

  /** @type {import("./progress-service.js").ProgressEvent[]} */
  const events = [];
  // Subscribe first (early attach) so we capture the `total` event live.
  subscribe(jobId, (e) => events.push(e));

  createJob(jobId, { totalPages });

  order.forEach((pageNumber, i) => {
    startPage(jobId, pageNumber);
    completePage(jobId, pageNumber, { failed: failedFlags[i] ?? false });
  });

  if (doComplete) {
    completeJob(jobId);
  }

  return events;
}

/**
 * Independently compute the expected displayed percentage, mirroring the module's
 * documented one-decimal rounding and the "<100 while pages remain" clamp. Used to
 * validate Property 4's intent rather than re-deriving from the event itself.
 *
 * @param {number} completedCount
 * @param {number} totalPages
 * @returns {number}
 */
function expectedPercentage(completedCount, totalPages) {
  if (totalPages === 0) return 100;
  if (completedCount >= totalPages) return 100;
  let pct = Math.round((completedCount / totalPages) * 100 * 10) / 10;
  if (pct >= 100) pct = 99.9;
  return pct;
}

// Arbitrary that yields a coherent scenario: a random totalPages (0..50, with 0
// included), a random shuffled subset of valid page numbers to complete, a
// matching array of failed flags, and whether to finish with completeJob.
const scenarioArb = fc
  .integer({ min: 0, max: 50 })
  .chain((totalPages) => {
    const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    return fc.record({
      totalPages: fc.constant(totalPages),
      order: fc.shuffledSubarray(pages),
      failedFlags: fc.array(fc.boolean(), { minLength: 0, maxLength: 50 }),
      doComplete: fc.boolean(),
    });
  });

describe("Progress_Service correctness properties (fast-check)", () => {
  it("Property 1: Bounded completion — 0 <= completedCount <= totalPages for every event. Validates: Requirements 7.1, 7.2", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (const e of events) {
          expect(e.completedCount).toBeGreaterThanOrEqual(0);
          expect(e.completedCount).toBeLessThanOrEqual(e.totalPages);
        }
      })
    );
  });

  it("Property 2: Monotonic completion — successive events have non-decreasing completedCount. Validates: Requirements 4.4, 7.1", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (let i = 1; i < events.length; i++) {
          expect(events[i].completedCount).toBeGreaterThanOrEqual(
            events[i - 1].completedCount
          );
        }
      })
    );
  });

  it("Property 3: Remaining identity — remainingCount === totalPages - completedCount. Validates: Requirements 4.2", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (const e of events) {
          expect(e.remainingCount).toBe(e.totalPages - e.completedCount);
        }
      })
    );
  });

  it("Property 4: Percentage identity — percentage matches (totalPages===0 ? 100 : rounded completedCount/totalPages*100). Validates: Requirements 4.3", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (const e of events) {
          expect(e.percentage).toBe(
            expectedPercentage(e.completedCount, e.totalPages)
          );
        }
      })
    );
  });

  it("Property 5: Percentage monotonicity — successive events have non-decreasing percentage. Validates: Requirements 7.4", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (let i = 1; i < events.length; i++) {
          expect(events[i].percentage).toBeGreaterThanOrEqual(
            events[i - 1].percentage
          );
        }
      })
    );
  });

  it("Property 6: 100% only when done — percentage === 100 implies completedCount === totalPages || totalPages === 0. Validates: Requirements 7.3", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const events = runScenario(scenario);
        for (const e of events) {
          if (e.percentage === 100) {
            expect(
              e.completedCount === e.totalPages || e.totalPages === 0
            ).toBe(true);
          }
        }
      })
    );
  });

  it("sanity: computeMetrics agrees with the emitted event metrics for the final job state", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const jobId = nextJobId();
        const events = [];
        subscribe(jobId, (e) => events.push(e));
        createJob(jobId, { totalPages: scenario.totalPages });
        scenario.order.forEach((pageNumber, i) => {
          startPage(jobId, pageNumber);
          completePage(jobId, pageNumber, {
            failed: scenario.failedFlags[i] ?? false,
          });
        });

        const job = getJob(jobId);
        const metrics = computeMetrics(job);
        const last = events[events.length - 1];
        expect(last.completedCount).toBe(metrics.completedCount);
        expect(last.remainingCount).toBe(metrics.remainingCount);
        expect(last.percentage).toBe(metrics.percentage);
      })
    );
  });
});
