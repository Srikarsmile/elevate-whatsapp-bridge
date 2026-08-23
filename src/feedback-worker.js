import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseHermesEvaluation } from "./evaluation-queue.js";

const PYTHON_PATH = "/usr/local/lib/hermes-agent/venv/bin/python";
const WRAPPER_PATH = "/srv/elevate-whatsapp-bridge/worker/hermes_eval.py";
const WORKER_CWD = "/var/empty/elevate-feedback-worker";
const STDOUT_LIMIT = 128 * 1024;
const STDERR_LIMIT = 16 * 1024;
const TIMEOUT_MS = 90_000;
const ALLOWED_ENV = [
  "HOME",
  "HERMES_HOME",
  "PATH",
  "HERMES_EVAL_MODEL",
  "HERMES_EVAL_PROVIDER",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function retryDelay(failures) {
  return Math.min(5_000 * 2 ** Math.max(0, failures - 1), 5 * 60 * 1000);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildWorkerEnv(source) {
  if (source.HERMES_EVAL_MODEL !== "gpt-5.6-sol") {
    throw new Error("HERMES_EVAL_MODEL must be gpt-5.6-sol");
  }
  if (source.HERMES_EVAL_PROVIDER !== "openai-codex") {
    throw new Error("HERMES_EVAL_PROVIDER must be openai-codex");
  }
  const result = {};
  for (const key of ALLOWED_ENV) {
    if (typeof source[key] === "string" && source[key].length > 0) result[key] = source[key];
  }
  return result;
}

export async function runHermesJob(
  job,
  {
    spawnImpl = spawn,
    workerEnv,
    pythonPath = PYTHON_PATH,
    wrapperPath = WRAPPER_PATH,
    cwd = WORKER_CWD,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }
) {
  const env = buildWorkerEnv(workerEnv);
  let child;
  try {
    child = spawnImpl(pythonPath, [wrapperPath], {
      shell: false,
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { errorCode: "spawn_error" };
  }

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(outcome);
    };
    const killAndFinish = (errorCode) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
      finish({ errorCode });
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > STDOUT_LIMIT) killAndFinish("output_too_large");
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > STDERR_LIMIT) killAndFinish("output_too_large");
    });
    child.once("error", () => finish({ errorCode: "spawn_error" }));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ errorCode: "process_error" });
        return;
      }
      let value;
      try {
        value = JSON.parse(stdout.toString("utf8"));
      } catch {
        finish({ errorCode: "invalid_json" });
        return;
      }
      try {
        finish({ result: parseHermesEvaluation(value, job.transcript.length) });
      } catch {
        finish({ errorCode: "invalid_output" });
      }
    });

    const timer = setTimeoutImpl(() => killAndFinish("timeout"), TIMEOUT_MS);
    try {
      child.stdin.end(
        JSON.stringify({
          interaction_id: job.interaction_id,
          app_version: job.app_version,
          transcript: job.transcript,
          deterministic_evaluation: job.deterministic_evaluation,
        })
      );
    } catch {
      killAndFinish("process_error");
    }
  });
}

async function bridgeRequest(fetchImpl, baseUrl, token, action, body) {
  const response = await fetchImpl(`${baseUrl}/v1/internal/evaluations/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
  return response.json();
}

export function createFeedbackWorker({
  baseUrl,
  token,
  workerEnv,
  fetchImpl = fetch,
  spawnImpl = spawn,
  sleep = defaultSleep,
  logger = console,
  pythonPath = PYTHON_PATH,
  wrapperPath = WRAPPER_PATH,
  cwd = WORKER_CWD,
}) {
  if (typeof token !== "string" || token.length < 24) {
    throw new Error("Feedback worker token must be at least 24 characters");
  }
  const parsedBaseUrl = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsedBaseUrl.hostname)) {
    throw new Error("Feedback bridge URL must be loopback-only");
  }
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const env = buildWorkerEnv(workerEnv);
  let consecutiveFailures = 0;
  let stopping = false;
  let loop = null;

  async function runOnce() {
    let claimed;
    try {
      claimed = await bridgeRequest(fetchImpl, normalizedBaseUrl, token, "claim", {});
    } catch {
      consecutiveFailures += 1;
      logger.error({ status: "evaluation_claim_failed" });
      await sleep(retryDelay(consecutiveFailures));
      return false;
    }
    if (!claimed.job) {
      consecutiveFailures = 0;
      await sleep(5000);
      return false;
    }

    const outcome = await runHermesJob(claimed.job, {
      spawnImpl,
      workerEnv: env,
      pythonPath,
      wrapperPath,
      cwd,
    });
    const completion = {
      job_id: claimed.job.job_id,
      lease_token: claimed.job.lease_token,
      ...(outcome.result ? { result: outcome.result } : { error_code: outcome.errorCode }),
    };
    try {
      await bridgeRequest(fetchImpl, normalizedBaseUrl, token, "complete", completion);
    } catch {
      consecutiveFailures += 1;
      logger.error({ jobId: claimed.job.job_id, status: "evaluation_complete_failed" });
      await sleep(retryDelay(consecutiveFailures));
      return false;
    }

    if (outcome.errorCode) {
      consecutiveFailures += 1;
      logger.error({
        jobId: claimed.job.job_id,
        status: "evaluation_failed",
        errorCode: outcome.errorCode,
      });
      await sleep(retryDelay(consecutiveFailures));
    } else {
      consecutiveFailures = 0;
      logger.info({ jobId: claimed.job.job_id, status: "evaluation_complete" });
    }
    return true;
  }

  async function start() {
    if (loop) return loop;
    stopping = false;
    loop = (async () => {
      while (!stopping) await runOnce();
    })();
    return loop;
  }

  async function stop() {
    stopping = true;
    if (loop) await loop;
    loop = null;
  }

  return Object.freeze({ runOnce, start, stop, status: () => (loop ? "running" : "stopped") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = createFeedbackWorker({
    baseUrl: process.env.FEEDBACK_BRIDGE_URL || "http://127.0.0.1:3218",
    token: process.env.FEEDBACK_WORKER_TOKEN,
    workerEnv: process.env,
    logger: {
      info: (value) => console.log(JSON.stringify(value)),
      error: (value) => console.error(JSON.stringify(value)),
    },
  });
  process.once("SIGTERM", () => void worker.stop());
  process.once("SIGINT", () => void worker.stop());
  await worker.start();
}
