// Progress_Service — in-memory job registry + single source of truth for
// realtime PDF parse progress metrics.
//
// This module owns all per-job state for the "AI Pro Max" vision parse flow and
// computes every number the teacher sees (completed count, remaining, percentage,
// ETA). Because all metric derivation lives here, the monotonicity/correctness
// rules from the design ("Derived-value rules") are enforced in exactly one place.
//
// Task 2.1 scope: the JobState structure, the module-level registry, the
// centralized derived-value computation (`computeMetrics`), and the shared
// ProgressEvent builder (`buildEvent`). Lifecycle functions (createJob,
// completePage, completeJob, …) and the subscribe/replay pub-sub are added by
// tasks 2.2 and 2.3 on top of these foundations.
//
// Everything is JavaScript ES modules to match the rest of `backend/src/*.js`.

/**
 * @typedef {"total" | "progress" | "stopped" | "complete" | "failure"} ProgressEventType
 */

/**
 * @typedef {Object} ProgressPage
 * @property {number} number      Page number (1-based).
 * @property {"done" | "failed"} outcome  Whether the page extracted or failed.
 * @property {number} durationMs  Measured processing time for the page (>= 0).
 */

/**
 * The JSON-serializable payload delivered over SSE. Every event type shares this
 * common metrics shape so the frontend can update uniformly.
 *
 * @typedef {Object} ProgressEvent
 * @property {ProgressEventType} type
 * @property {string} jobId
 * @property {number} totalPages       Fixed for the job once known (0 allowed).
 * @property {number} completedCount   Pages finished so far (monotonic non-decreasing).
 * @property {number} remainingCount   totalPages - completedCount (never negative).
 * @property {number} percentage       0..100; 100 only when completedCount === totalPages (or totalPages === 0).
 * @property {number | null} etaSeconds  null until >=1 page done; 0 when remainingCount === 0.
 * @property {ProgressPage} [page]     Present on "progress" events.
 * @property {string} [message]        Present on "failure" (cause) and "stopped" (reason).
 * @property {string} emittedAt        ISO timestamp of emission.
 */

/**
 * In-memory state for a single Processing_Job. Held only in this process.
 *
 * @typedef {Object} JobState
 * @property {string} jobId
 * @property {number} totalPages
 * @property {Set<number>} completed          Page numbers that have finished.
 * @property {number[]} durationsMs           Measured durations, one per completed page (may include 0).
 * @property {Map<number, number>} startedAt  pageNumber -> start timestamp (ms).
 * @property {"running" | "complete" | "stopped" | "failed"} status
 * @property {boolean} initialized           False for a pending placeholder created by an
 *                                           early subscriber (no `total` event emitted yet);
 *                                           set true once `createJob` initializes the job.
 * @property {ProgressEvent[]} events         Ordered buffer for replay.
 * @property {Set<(e: ProgressEvent) => void>} subscribers  Live subscriber callbacks.
 * @property {ReturnType<typeof setTimeout> | undefined} disposeTimer  Auto-dispose timer.
 */

/**
 * Module-level registry mapping a jobId to its in-memory JobState.
 * This is the single source of truth for all live jobs in this process.
 *
 * @type {Map<string, JobState>}
 */
export const registry = new Map();

/**
 * Create a fresh, empty JobState record. Does not register it — callers (task 2.2
 * `createJob`) decide when to insert into the registry. Kept here so the shape of
 * a job is defined in one place alongside the metric rules that read it.
 *
 * @param {string} jobId
 * @param {number} totalPages
 * @returns {JobState}
 */
export function createJobState(jobId, totalPages) {
  return {
    jobId,
    totalPages,
    completed: new Set(),
    durationsMs: [],
    startedAt: new Map(),
    status: "running",
    // A freshly built state is an uninitialized placeholder until createJob emits
    // its `total` event. createJob flips this to true; the subscribe() early-attach
    // path leaves it false so a later createJob knows to initialize (not no-op).
    initialized: false,
    events: [],
    subscribers: new Set(),
    disposeTimer: undefined,
    // Final parse result (questions + metadata), stored when the background job
    // finishes so the client can fetch it via the result endpoint. Because the
    // heavy parse now runs in the background (the HTTP request returns
    // immediately to avoid gateway 502s on big PDFs), the questions are not in
    // the POST response — they are picked up from here.
    result: null,
  };
}

/** Store the final parse result for a job (questions + metadata). */
export function setJobResult(jobId, result) {
  const job = getJob(jobId);
  if (job) job.result = result;
}

/** Read the final parse result for a job (null if not ready yet / unknown job). */
export function getJobResult(jobId) {
  const job = getJob(jobId);
  return job ? job.result ?? null : null;
}

/**
 * Look up a job by id.
 *
 * @param {string} jobId
 * @returns {JobState | undefined}
 */
export function getJob(jobId) {
  return registry.get(jobId);
}

/**
 * Compute the average of an array of measured durations, treating an empty array
 * as 0. Zero-duration entries are intentionally included in the average per the
 * design's ETA rule (Req 5.2).
 *
 * @param {number[]} durationsMs
 * @returns {number} average duration in milliseconds
 */
function averageDurationMs(durationsMs) {
  if (durationsMs.length === 0) return 0;
  let sum = 0;
  for (const d of durationsMs) sum += d;
  return sum / durationsMs.length;
}

/**
 * Round a number to one decimal place (for percentage display).
 *
 * @param {number} value
 * @returns {number}
 */
function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Centralized derived-value computation, run on every emit. This is the single
 * source of truth for the reported metrics; all correctness rules live here.
 *
 * Rules (from design "Derived-value rules"):
 *  - completedCount = completed.size
 *  - remainingCount = max(0, totalPages - completedCount)
 *  - percentage     = totalPages === 0 ? 100 : (completedCount / totalPages) * 100
 *                     rounded to one decimal for display, but exactly 100 ONLY
 *                     when completedCount === totalPages (rounding must never
 *                     push a real value < 100 up to a displayed 100).
 *  - etaSeconds     = null  when completedCount === 0 && totalPages > 0
 *                     0     when remainingCount === 0
 *                     else  average(durationsMs) * remainingCount / 1000
 *
 * @param {JobState} job
 * @returns {{ completedCount: number, remainingCount: number, percentage: number, etaSeconds: number | null }}
 */
export function computeMetrics(job) {
  const totalPages = job.totalPages;
  const completedCount = job.completed.size;
  const remainingCount = Math.max(0, totalPages - completedCount);

  // Percentage.
  let percentage;
  if (totalPages === 0) {
    percentage = 100;
  } else if (completedCount >= totalPages) {
    // Fully complete — exactly 100.
    percentage = 100;
  } else {
    percentage = roundOneDecimal((completedCount / totalPages) * 100);
    // Guard: never let rounding display 100 (or above) while pages remain.
    // e.g. 9999/10000 = 99.99 would round to 100.0 — clamp it down.
    if (percentage >= 100) percentage = 99.9;
  }

  // ETA.
  let etaSeconds;
  if (remainingCount === 0) {
    etaSeconds = 0;
  } else if (completedCount === 0) {
    // totalPages > 0 here (otherwise remainingCount would be 0), so unavailable.
    etaSeconds = null;
  } else {
    etaSeconds = (averageDurationMs(job.durationsMs) * remainingCount) / 1000;
  }

  return { completedCount, remainingCount, percentage, etaSeconds };
}

/**
 * Build the shared ProgressEvent payload for a job. All emitters (createJob,
 * completePage, completeJob, stopJob, failJob in task 2.2) go through this so the
 * metrics shape and derived values are identical across every event type.
 *
 * @param {JobState} job
 * @param {ProgressEventType} type
 * @param {{ page?: ProgressPage, message?: string }} [extra]  Optional per-event fields.
 * @returns {ProgressEvent}
 */
export function buildEvent(job, type, extra = {}) {
  const { completedCount, remainingCount, percentage, etaSeconds } =
    computeMetrics(job);

  /** @type {ProgressEvent} */
  const event = {
    type,
    jobId: job.jobId,
    totalPages: job.totalPages,
    completedCount,
    remainingCount,
    percentage,
    etaSeconds,
    emittedAt: new Date().toISOString(),
  };

  if (extra.page !== undefined) event.page = extra.page;
  if (extra.message !== undefined) event.message = extra.message;
  // Optional human-readable note about the engine/key processing this page,
  // e.g. "Key 2 of 4" or "Groq (fast)". Surfaced live in the UI.
  if (extra.note !== undefined) event.note = extra.note;

  return event;
}

// ---------------------------------------------------------------------------
// Task 2.2: Job lifecycle functions.
//
// These build ON TOP of the task-2.1 helpers (registry, createJobState, getJob,
// computeMetrics, buildEvent). They own the state transitions for a job and are
// the only place events are emitted. Every function guards against a missing job
// gracefully (no throw) EXCEPT createJob, which creates the job.
// ---------------------------------------------------------------------------

/**
 * Milliseconds to keep a terminal job's state alive before auto-disposing it, so
 * a slightly-late (or reconnecting) subscriber can still replay the final buffer.
 */
const AUTO_DISPOSE_MS = Number(process.env.PROGRESS_DISPOSE_MS || 600000); // 10 min — keep result long enough to fetch

/**
 * Emit an event for a job: build the shared payload via `buildEvent`, push it to
 * the ordered replay buffer, and synchronously invoke every live subscriber.
 * Subscriber callbacks are isolated so one throwing observer cannot break the
 * emit for the others (or for the buffer).
 *
 * @param {JobState} job
 * @param {ProgressEventType} type
 * @param {{ page?: ProgressPage, message?: string }} [extra]
 * @returns {ProgressEvent} the emitted event
 */
function emit(job, type, extra) {
  const event = buildEvent(job, type, extra);
  job.events.push(event);
  for (const subscriber of job.subscribers) {
    try {
      subscriber(event);
    } catch {
      // A misbehaving subscriber must not break emission for others.
    }
  }
  return event;
}

/**
 * Schedule (or reschedule) auto-dispose of a job ~60s after a terminal
 * transition. Any previously scheduled timer is cleared first so repeated
 * terminal calls do not stack timers. The timer is `unref`'d so it never keeps
 * the Node process alive on its own.
 *
 * @param {JobState} job
 */
function scheduleAutoDispose(job) {
  if (job.disposeTimer !== undefined) {
    clearTimeout(job.disposeTimer);
  }
  const timer = setTimeout(() => {
    disposeJob(job.jobId);
  }, AUTO_DISPOSE_MS);
  // Node's Timeout exposes unref(); guard for non-Node environments/tests.
  if (typeof timer.unref === "function") timer.unref();
  job.disposeTimer = timer;
}

/**
 * Register a job and emit its initial `total` event. Idempotent: if a job with
 * the same id already exists it is returned untouched (no state reset, no second
 * `total` event). The `total` event is emitted SYNCHRONOUSLY here, before any
 * per-page event can occur, satisfying the total-first ordering guarantee.
 *
 * @param {string} jobId
 * @param {{ totalPages: number }} params
 * @returns {JobState} the (new or existing) job
 */
export function createJob(jobId, { totalPages }) {
  const existing = getJob(jobId);
  if (existing !== undefined) {
    // A pending placeholder (created by an early subscribe() before the job was
    // registered) has no `total` event yet. Initialize it now: set the real
    // totalPages and emit the initial `total` event to any already-attached
    // subscriber. If the job was already fully initialized, stay idempotent —
    // no state reset, no second `total` event.
    if (!existing.initialized) {
      existing.totalPages = totalPages;
      existing.initialized = true;
      emit(existing, "total");
    }
    return existing;
  }

  const job = createJobState(jobId, totalPages);
  job.initialized = true;
  registry.set(jobId, job);
  emit(job, "total");
  return job;
}

/**
 * Record the start timestamp for a page so its processing duration can be
 * measured when it completes. No event is emitted. Missing job is ignored.
 *
 * @param {string} jobId
 * @param {number} pageNumber
 */
export function startPage(jobId, pageNumber) {
  const job = getJob(jobId);
  if (job === undefined) return;
  job.startedAt.set(pageNumber, Date.now());
}

/**
 * Mark a page complete and emit a `progress` event.
 *
 * Rules:
 *  - durationMs = max(0, now - startedAt) if a start was recorded, else 0.
 *  - Page numbers outside [1, totalPages] are ignored entirely (no event).
 *  - Completion is idempotent: re-completing an already-completed page does not
 *    push another duration nor double-count; it also emits no event.
 *
 * @param {string} jobId
 * @param {number} pageNumber
 * @param {{ failed?: boolean }} [options]
 */
export function completePage(jobId, pageNumber, { failed, note } = {}) {
  const job = getJob(jobId);
  if (job === undefined) return;

  // Ignore out-of-range page numbers.
  if (pageNumber < 1 || pageNumber > job.totalPages) return;

  // Idempotent: already-completed pages produce nothing.
  if (job.completed.has(pageNumber)) return;

  const startedAt = job.startedAt.get(pageNumber);
  const durationMs =
    startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);

  job.completed.add(pageNumber);
  job.durationsMs.push(durationMs);

  emit(job, "progress", {
    page: {
      number: pageNumber,
      outcome: failed ? "failed" : "done",
      durationMs,
    },
    ...(note !== undefined ? { note } : {}),
  });
}

/**
 * Terminal: mark ALL pages complete, set status `complete`, and emit the
 * terminal `complete` event. Fills the `completed` Set with 1..totalPages so
 * `completedCount === totalPages` (and `percentage === 100`). For a zero-page job
 * this leaves `completedCount === 0`, and `computeMetrics` yields
 * remaining 0 / percentage 100 / etaSeconds 0. Schedules auto-dispose.
 *
 * @param {string} jobId
 */
export function completeJob(jobId) {
  const job = getJob(jobId);
  if (job === undefined) return;

  for (let pageNumber = 1; pageNumber <= job.totalPages; pageNumber++) {
    job.completed.add(pageNumber);
  }
  job.status = "complete";
  emit(job, "complete");
  scheduleAutoDispose(job);
}

/**
 * Terminal: set status `stopped` and emit a terminal `stopped` event carrying the
 * current (partial) completed count and the stop reason as `message`. Schedules
 * auto-dispose.
 *
 * @param {string} jobId
 * @param {{ reason?: string }} [options]
 */
export function stopJob(jobId, { reason } = {}) {
  const job = getJob(jobId);
  if (job === undefined) return;

  job.status = "stopped";
  emit(job, "stopped", { message: reason });
  scheduleAutoDispose(job);
}

/**
 * Terminal: set status `failed` and emit a terminal `failure` event with the
 * given cause `message`. Emits NO per-page events. Schedules auto-dispose.
 *
 * @param {string} jobId
 * @param {{ message?: string }} [options]
 */
export function failJob(jobId, { message } = {}) {
  const job = getJob(jobId);
  if (job === undefined) return;

  job.status = "failed";
  emit(job, "failure", { message });
  scheduleAutoDispose(job);
}

/**
 * Whether a job has reached a terminal state (complete/stopped/failed). Returns
 * false for a missing job.
 *
 * @param {string} jobId
 * @returns {boolean}
 */
export function isTerminal(jobId) {
  const job = getJob(jobId);
  if (job === undefined) return false;
  return (
    job.status === "complete" ||
    job.status === "stopped" ||
    job.status === "failed"
  );
}

/**
 * Free a job's resources: clear its event buffer and subscriber set, clear any
 * pending auto-dispose timer, and remove it from the registry. Safe to call on a
 * missing job.
 *
 * @param {string} jobId
 */
export function disposeJob(jobId) {
  const job = getJob(jobId);
  if (job === undefined) return;

  if (job.disposeTimer !== undefined) {
    clearTimeout(job.disposeTimer);
    job.disposeTimer = undefined;
  }
  job.events.length = 0;
  job.subscribers.clear();
  registry.delete(jobId);
}

// ---------------------------------------------------------------------------
// Task 2.3: subscribe / replay pub-sub.
//
// Built ON TOP of the existing registry + emit(). This is the only place a live
// observer attaches to a job. It solves the ordering race (design "Late / early
// subscriber"): a subscriber may attach BEFORE the job is registered, or AFTER
// several pages already finished — either way it converges to the current state.
// ---------------------------------------------------------------------------

/**
 * Attach a live observer to a job and converge it to the current state.
 *
 * Behavior:
 *  - If the job does not exist yet, create a PENDING placeholder JobState and
 *    register it WITHOUT emitting a `total` event (only createJob emits `total`).
 *    Its `events` buffer stays empty until createJob initializes it, at which
 *    point the already-attached subscriber receives the `total` event live.
 *  - Register `onEvent` in `job.subscribers` so future `emit()`s reach it live.
 *  - Synchronously replay every event already buffered in `job.events`, in order,
 *    so a late subscriber catches up. Because JavaScript is single-threaded and
 *    the replay loop is synchronous, no live emit can interleave with the replay,
 *    so no event is duplicated or missed.
 *
 * The first event any subscriber observes for a real job is always the `total`
 * event: a real job's buffer always begins with `total`, and a pending
 * placeholder replays nothing until createJob emits `total`.
 *
 * @param {string} jobId
 * @param {(e: ProgressEvent) => void} onEvent  Callback invoked per event.
 * @returns {() => void} unsubscribe function that removes the callback.
 */
export function subscribe(jobId, onEvent) {
  let job = getJob(jobId);
  if (job === undefined) {
    // Pending placeholder — totalPages is unknown until createJob runs, and no
    // `total` event is emitted here. `initialized` stays false so a later
    // createJob knows to initialize it rather than treat it as a no-op.
    job = createJobState(jobId, 0);
    registry.set(jobId, job);
  }

  job.subscribers.add(onEvent);

  // Replay the ordered buffer so the subscriber converges to current state.
  // An isolated try/catch mirrors emit(): a throwing observer must not break
  // the replay loop.
  for (const event of job.events) {
    try {
      onEvent(event);
    } catch {
      // A misbehaving subscriber must not break replay for the caller.
    }
  }

  const subscribers = job.subscribers;
  return function unsubscribe() {
    subscribers.delete(onEvent);
  };
}
