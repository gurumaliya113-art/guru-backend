// Integration tests for the SSE progress endpoint (task 5.4).
//
// Exercises the real `GET /api/admin/parse-pdf/progress/:jobId` route mounted on
// an Express app (via buildAdminRouter), driving the Progress_Service directly to
// simulate a parse job — the heavy POST /parse-pdf (Gemini/render) is never run.
//
// Covers the four scenarios from the design's "Testing Strategy > Integration
// testing" and Component 2 (SSE endpoint contract):
//   1. End-to-end ordered delivery: total -> N x progress -> complete, then close.
//        _Requirements: 1.3, 2.2, 3.4, 3.5_
//   2. Auth: no token / no session -> 401; valid ?token= -> 200 and streams.
//        _Requirements: 3.3_
//   3. Continues after disconnect (observer-only): dropping the SSE client does
//      not affect the running job; it still reaches a terminal state.
//        _Requirements: 3.6, 3.2_
//   4. Race replay: a page completed before subscribing still replays `total`
//      first, then the page-1 `progress` event.
//        _Requirements: 1.3, 3.2_

import http from "http";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import request from "supertest";

import { buildAdminRouter } from "./admin-routes.js";
import { adminLogin } from "./auth.js";
import {
  registry,
  createJob,
  startPage,
  completePage,
  completeJob,
  isTerminal,
} from "./progress-service.js";

// A valid admin token is minted through the real adminLogin so the ?token= path
// through requireAdmin behaves exactly as in production. We set deterministic
// credentials in the environment first (NODE_ENV is not "production" under
// Vitest, so the default-password guard does not apply).
let ADMIN_TOKEN;
let app;
let server;
let baseUrl;

const ADMIN_EMAIL = "admin@sse-test.local";
const ADMIN_PASSWORD = "sse-test-password-123";

// ---- helpers ---------------------------------------------------------------

// Extract, in order, the value of every `event: <type>` line in an SSE payload.
function eventTypes(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length).trim());
}

// Parse the JSON payload of the first `data: {...}` line whose event type matches.
function firstDataFor(body, type) {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `event: ${type}`) {
      // The data line follows the event line.
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("data: ")) {
          return JSON.parse(lines[j].slice("data: ".length));
        }
      }
    }
  }
  return null;
}

// Open a RAW SSE connection against the running server and accumulate the body.
// Resolves when either the stream ends naturally (terminal event closed it) or
// the `until(body)` predicate becomes true, at which point the request is
// destroyed to simulate a client disconnect. `maxMs` is a safety timeout.
function readSSE(path, { until, maxMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        // already torn down
      }
      resolve(result);
    };

    const req = http.get(baseUrl + path, (res) => {
      let body = "";
      res.setEncoding("utf8");
      const timer = setTimeout(() => finish({ status: res.statusCode, body, timedOut: true }), maxMs);
      if (typeof timer.unref === "function") timer.unref();

      res.on("data", (chunk) => {
        body += chunk;
        if (until && until(body)) {
          clearTimeout(timer);
          finish({ status: res.statusCode, body, disconnected: true });
        }
      });
      const endHandler = () => {
        clearTimeout(timer);
        finish({ status: res.statusCode, body, ended: true });
      };
      res.on("end", endHandler);
      res.on("close", endHandler);
    });

    req.on("error", (err) => {
      // A destroy() we initiated shows up here as ECONNRESET/aborted — ignore it
      // once we've already settled. A genuine pre-settle error is a real failure.
      if (settled) return;
      reject(err);
    });
  });
}

// A progress event is written as two separate res.write calls
// (`event: progress\n` then `data: {...}\n\n`) which can land in different TCP
// chunks. This predicate is true only once the FULL progress block — including
// its data line and terminating blank line — has been received, so the body is
// safe to parse.
const sawFullProgress = (body) => {
  const idx = body.indexOf("event: progress");
  return idx !== -1 && body.indexOf("\n\n", idx) !== -1;
};

// Wait a macrotask so the server's `req.on("close")` handler runs after a
// client disconnect before we assert on post-disconnect behavior.
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---- setup / teardown ------------------------------------------------------

beforeAll(async () => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  ADMIN_TOKEN = adminLogin(ADMIN_EMAIL, ADMIN_PASSWORD);

  app = express();
  app.use(express.json());
  // Stub storage — the SSE route never touches it.
  app.use("/api/admin", buildAdminRouter({}));

  // Real listening server for the raw-http (disconnect / race) tests.
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

afterEach(() => {
  // Drop all job state (and any scheduled auto-dispose timers are unref'd, so
  // clearing the registry is enough to isolate tests).
  registry.clear();
});

let seq = 0;
const uniqueJobId = (label) => `sse-it-${label}-${Date.now()}-${seq++}`;

// ---------------------------------------------------------------------------

describe("SSE progress endpoint — integration", () => {
  it("delivers total -> progress x N -> complete in order, then closes the stream (Req 1.3, 2.2, 3.4, 3.5)", async () => {
    const jobId = uniqueJobId("ordered");

    // Drive the whole job BEFORE subscribing; the endpoint replays the buffered
    // events in order on connect and closes on the terminal `complete` — a fully
    // deterministic way to assert ordering without racing the stream.
    createJob(jobId, { totalPages: 3 });
    for (const page of [1, 2, 3]) {
      startPage(jobId, page);
      completePage(jobId, page, { failed: false });
    }
    completeJob(jobId);

    const res = await request(app).get(
      `/api/admin/parse-pdf/progress/${jobId}?token=${ADMIN_TOKEN}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Ordered arrival: the initial comment, then total, three progress, complete.
    expect(res.text).toContain(": connected");
    expect(eventTypes(res.text)).toEqual([
      "total",
      "progress",
      "progress",
      "progress",
      "complete",
    ]);

    // The terminal event carries a fully-complete payload and the stream closed
    // (supertest only resolves once the response has ended).
    const complete = firstDataFor(res.text, "complete");
    expect(complete.completedCount).toBe(3);
    expect(complete.totalPages).toBe(3);
    expect(complete.percentage).toBe(100);
  });

  it("rejects a request with no token and no admin session (Req 3.3)", async () => {
    const jobId = uniqueJobId("noauth");
    createJob(jobId, { totalPages: 1 });

    const res = await request(app).get(
      `/api/admin/parse-pdf/progress/${jobId}`,
    );

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Admin authentication required" });
  });

  it("streams events for a request with a valid ?token= (Req 3.3)", async () => {
    const jobId = uniqueJobId("auth-ok");
    createJob(jobId, { totalPages: 1 });
    startPage(jobId, 1);
    completePage(jobId, 1, { failed: false });
    completeJob(jobId);

    const res = await request(app).get(
      `/api/admin/parse-pdf/progress/${jobId}?token=${ADMIN_TOKEN}`,
    );

    expect(res.status).toBe(200);
    expect(eventTypes(res.text)).toEqual(["total", "progress", "complete"]);
  });

  it("rejects a request with an invalid token (Req 3.3)", async () => {
    const jobId = uniqueJobId("bad-token");
    createJob(jobId, { totalPages: 1 });

    const res = await request(app).get(
      `/api/admin/parse-pdf/progress/${jobId}?token=not-a-real-token`,
    );

    expect(res.status).toBe(401);
  });

  it("keeps the job running after the SSE client disconnects — observer only (Req 3.6, 3.2)", async () => {
    const jobId = uniqueJobId("disconnect");

    // Start a job and finish one page so an early subscriber has something to
    // replay, then connect and immediately drop the connection mid-job.
    createJob(jobId, { totalPages: 3 });
    startPage(jobId, 1);
    completePage(jobId, 1, { failed: false });

    const result = await readSSE(
      `/api/admin/parse-pdf/progress/${jobId}?token=${ADMIN_TOKEN}`,
      { until: sawFullProgress },
    );

    // We saw the buffered events, then disconnected (not a natural stream end).
    expect(result.status).toBe(200);
    expect(result.disconnected).toBe(true);
    expect(eventTypes(result.body)).toContain("total");

    // Let the server's req.on("close") unsubscribe handler run.
    await tick();

    // Driving the remaining pages after the client vanished must not throw and
    // the job must still reach a terminal state — proving the stream is a
    // passive observer that never controls the parse.
    expect(() => {
      startPage(jobId, 2);
      completePage(jobId, 2, { failed: false });
      startPage(jobId, 3);
      completePage(jobId, 3, { failed: false });
      completeJob(jobId);
    }).not.toThrow();

    expect(isTerminal(jobId)).toBe(true);
    expect(registry.get(jobId)?.status).toBe("complete");
    expect(registry.get(jobId)?.completed.size).toBe(3);
  });

  it("replays total before an already-completed page's progress event on a late subscribe (Req 1.3, 3.2)", async () => {
    const jobId = uniqueJobId("race");

    // A page completes BEFORE any client subscribes (the race the design's
    // buffer/replay solves).
    createJob(jobId, { totalPages: 3 });
    startPage(jobId, 1);
    completePage(jobId, 1, { failed: false });

    // Connect now; read until the buffered page-1 progress event arrives, then
    // disconnect (the job is still running, so the stream would otherwise stay
    // open).
    const result = await readSSE(
      `/api/admin/parse-pdf/progress/${jobId}?token=${ADMIN_TOKEN}`,
      { until: sawFullProgress },
    );

    expect(result.status).toBe(200);

    const types = eventTypes(result.body);
    // total must be the first event, and it must precede the page-1 progress.
    expect(types[0]).toBe("total");
    expect(types.indexOf("total")).toBeLessThan(types.indexOf("progress"));

    const progress = firstDataFor(result.body, "progress");
    expect(progress.page.number).toBe(1);
    expect(progress.completedCount).toBe(1);
  });
});
