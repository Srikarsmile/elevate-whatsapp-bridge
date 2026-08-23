import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  buildWorkerEnv,
  createFeedbackWorker,
  runHermesJob,
} from "../src/feedback-worker.js";

const token = "feedback-worker-token-with-at-least-32-characters";
const job = {
  job_id: "job-111111111111111111111111",
  event_id: "evt-111111111111111111111111",
  interaction_id: "interaction-123",
  app_version: 7,
  transcript: [
    { role: "agent", en_text: "What is the fictional goal?" },
    { role: "user", en_text: "A clearer catalogue." },
  ],
  deterministic_evaluation: { score: 90, findings: [] },
  lease_token: "lease-token-with-at-least-32-characters",
};

const result = {
  scores: {
    listening: 91,
    concision: 88,
    naturalness: 86,
    intent_accuracy: 92,
    task_completion: 90,
  },
  evidence: [{ turn_indexes: [0], failure_code: "stacked_questions" }],
  failures: ["stacked_questions"],
  prompt_delta: "Ask one question, then wait for the answer.",
  confidence: 0.83,
  insufficient_evidence: false,
};

function childProcess({ stdout = JSON.stringify(result), stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let stdin = "";
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      stdin += chunk.toString();
      callback();
    },
  });
  child.killCalls = [];
  child.kill = (signal) => child.killCalls.push(signal);
  child.input = () => stdin;
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

const workerEnv = {
  HOME: "/var/lib/elevate-feedback-worker",
  HERMES_HOME: "/var/lib/elevate-feedback-worker/.hermes",
  PATH: "/usr/local/bin:/usr/bin",
  HERMES_EVAL_MODEL: "gpt-5.6-sol",
  HERMES_EVAL_PROVIDER: "openai-codex",
  LANG: "C.UTF-8",
};

test("builds a narrow worker environment and drops bridge credentials", () => {
  assert.deepEqual(
    buildWorkerEnv({ ...workerEnv, BRIDGE_SECRET: "secret", SARVAM_API_KEY: "key" }),
    workerEnv
  );
  assert.throws(() => buildWorkerEnv({ ...workerEnv, HERMES_EVAL_MODEL: "other" }));
});

test("spawns the fixed tool-free wrapper and sends transcript content only on stdin", async () => {
  let spawned;
  const child = childProcess();
  const outcome = await runHermesJob(job, {
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return child;
    },
    workerEnv,
  });

  assert.deepEqual(outcome, { result });
  assert.equal(spawned.command, "/usr/local/lib/hermes-agent/venv/bin/python");
  assert.deepEqual(spawned.args, [
    "/srv/elevate-whatsapp-bridge/worker/hermes_eval.py",
  ]);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.cwd, "/var/empty/elevate-feedback-worker");
  assert.deepEqual(spawned.options.env, workerEnv);
  assert.doesNotMatch(JSON.stringify(spawned), /fictional goal|clearer catalogue/);
  assert.match(child.input(), /fictional goal|clearer catalogue/);
});

test("bounds output, kills timed-out children, and classifies process failures", async () => {
  for (const [childOptions, expected] of [
    [{ stdout: "x".repeat(129 * 1024) }, "output_too_large"],
    [{ stderr: "x".repeat(17 * 1024) }, "output_too_large"],
    [{ stdout: "not-json" }, "invalid_json"],
    [{ stdout: JSON.stringify({ ...result, extra: true }) }, "invalid_output"],
    [{ code: 1 }, "process_error"],
  ]) {
    assert.deepEqual(
      await runHermesJob(job, { spawnImpl: () => childProcess(childOptions), workerEnv }),
      { errorCode: expected }
    );
  }

  const timedOut = new EventEmitter();
  timedOut.stdout = new PassThrough();
  timedOut.stderr = new PassThrough();
  timedOut.stdin = new PassThrough();
  timedOut.killCalls = [];
  timedOut.kill = (signal) => timedOut.killCalls.push(signal);
  let timeoutCallback;
  const pending = runHermesJob(job, {
    spawnImpl: () => timedOut,
    workerEnv,
    setTimeoutImpl: (callback, milliseconds) => {
      assert.equal(milliseconds, 90_000);
      timeoutCallback = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  timeoutCallback();
  assert.deepEqual(await pending, { errorCode: "timeout" });
  assert.deepEqual(timedOut.killCalls, ["SIGKILL"]);
});

function apiResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("sleeps five seconds when no job is available", async () => {
  const sleeps = [];
  const worker = createFeedbackWorker({
    baseUrl: "http://127.0.0.1:3218",
    token,
    workerEnv,
    fetchImpl: async () => apiResponse({ ok: true, job: null }),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    logger: { info() {}, error() {} },
  });
  assert.equal(await worker.runOnce(), false);
  assert.deepEqual(sleeps, [5000]);
});

test("claims, evaluates, and completes a lease without logging model content", async () => {
  const requests = [];
  const logs = [];
  const worker = createFeedbackWorker({
    baseUrl: "http://127.0.0.1:3218",
    token,
    workerEnv,
    spawnImpl: () => childProcess(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith("/claim")
        ? apiResponse({ ok: true, job })
        : apiResponse({ ok: true, status: "complete", duplicate: false });
    },
    sleep: async () => {},
    logger: { info: (value) => logs.push(value), error: (value) => logs.push(value) },
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(requests.length, 2);
  const completion = JSON.parse(requests[1].options.body);
  assert.deepEqual(completion.result, result);
  assert.equal(completion.job_id, job.job_id);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /fictional goal|Ask one question/);
});

test("reports bounded error codes and caps worker retry sleeps at five minutes", async () => {
  const sleeps = [];
  let calls = 0;
  const worker = createFeedbackWorker({
    baseUrl: "http://127.0.0.1:3218",
    token,
    workerEnv,
    spawnImpl: () => childProcess({ code: 1 }),
    fetchImpl: async (url) => {
      calls += 1;
      if (url.endsWith("/claim")) return apiResponse({ ok: true, job });
      return apiResponse({ ok: true, status: "pending", duplicate: false });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    logger: { info() {}, error() {} },
  });
  for (let index = 0; index < 8; index += 1) await worker.runOnce();
  assert.equal(calls, 16);
  assert.equal(Math.max(...sleeps), 300_000);
  assert.ok(sleeps.every((delay) => delay <= 300_000));
});
