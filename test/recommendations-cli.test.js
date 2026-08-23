import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../bin/recommendations.js";

const env = {
  BRIDGE_BASE_URL: "http://127.0.0.1:3218",
  BRIDGE_SECRET: "bridge-secret-with-enough-entropy",
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("lists and shows recommendations through authenticated loopback requests", async () => {
  const calls = [];
  const output = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ ok: true, recommendations: [] });
  };
  await run(["list"], { env, fetchImpl, stdout: (line) => output.push(line) });
  await run(["show", "rec-111111111111111111111111"], {
    env,
    fetchImpl,
    stdout: (line) => output.push(line),
  });

  assert.equal(calls[0].url, "http://127.0.0.1:3218/v1/recommendations");
  assert.equal(
    calls[1].url,
    "http://127.0.0.1:3218/v1/recommendations/rec-111111111111111111111111"
  );
  assert.equal(calls[0].options.headers.authorization, `Bearer ${env.BRIDGE_SECRET}`);
  assert.ok(output.every((line) => !line.includes(env.BRIDGE_SECRET)));
});

test("sends strict approve, reject, and promote action bodies", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ ok: true });
  };
  const id = "rec-111111111111111111111111";

  await run(["approve", id], { env, fetchImpl, stdout() {} });
  await run(["reject", id, "--reason", "Insufficient evidence"], {
    env,
    fetchImpl,
    stdout() {},
  });
  await run(
    ["promote", id, "--version", "8", "--fixtures", "good-concise,stacked-questions"],
    { env, fetchImpl, stdout() {} }
  );

  assert.deepEqual(
    calls.map((call) => ({
      path: new URL(call.url).pathname,
      method: call.options.method,
      body: JSON.parse(call.options.body),
    })),
    [
      { path: `/v1/recommendations/${id}/approve`, method: "POST", body: {} },
      {
        path: `/v1/recommendations/${id}/reject`,
        method: "POST",
        body: { reason: "Insufficient evidence" },
      },
      {
        path: `/v1/recommendations/${id}/promote`,
        method: "POST",
        body: { version: 8, fixture_ids: ["good-concise", "stacked-questions"] },
      },
    ]
  );
});

test("fails closed on missing credentials, invalid arguments, and HTTP errors", async () => {
  await assert.rejects(() => run(["list"], { env: {}, fetchImpl: fetch, stdout() {} }));
  await assert.rejects(() =>
    run(["approve", "bad-id"], { env, fetchImpl: fetch, stdout() {} })
  );
  await assert.rejects(() =>
    run(["list"], {
      env,
      fetchImpl: async () => response({ error: "Denied" }, 403),
      stdout() {},
    })
  );
});
