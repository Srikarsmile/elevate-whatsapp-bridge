import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

const completeSarvamEnv = {
  SARVAM_API_KEY: "sarvam-test-key",
  SARVAM_ORG_ID: "org-test",
  SARVAM_WORKSPACE_ID: "workspace-test",
  SARVAM_APP_ID: "app-test",
  SARVAM_APP_VERSION: "7",
  SARVAM_CONNECTION_ID: "connection-test",
  SARVAM_AGENT_PHONE_NUMBER: "+91 80715 81315",
  SARVAM_WEBHOOK_BASE_URL: "https://example.test/elevate-whatsapp/",
  SARVAM_WEBHOOK_TOKEN: "webhook-token-with-at-least-32-characters",
  PHONE_HASH_SALT: "phone-hash-salt-with-at-least-32-characters",
};

test("defaults callback dispatch to disabled without Sarvam configuration", () => {
  assert.deepEqual(loadConfig({}), {
    callbackDispatchMode: "disabled",
    sarvamConfigured: false,
    sarvam: null,
    phoneHashSalt: null,
    webhookToken: null,
    feedbackWorkerToken: null,
  });
});

test("loads a complete Sarvam group while dispatch remains disabled", () => {
  const config = loadConfig(completeSarvamEnv);

  assert.equal(config.callbackDispatchMode, "disabled");
  assert.equal(config.sarvamConfigured, true);
  assert.equal(config.sarvam.appVersion, 7);
  assert.equal(config.sarvam.agentPhoneNumber, "+918071581315");
  assert.equal(config.sarvam.webhookBaseUrl, "https://example.test/elevate-whatsapp");
  assert.equal(config.webhookToken, completeSarvamEnv.SARVAM_WEBHOOK_TOKEN);
});

test("requires complete Sarvam configuration when any field is present", () => {
  assert.throws(
    () => loadConfig({ SARVAM_API_KEY: "partial" }),
    /Missing Sarvam environment.*SARVAM_ORG_ID/
  );
});

test("requires Sarvam configuration for dry-run and live modes", () => {
  assert.throws(() => loadConfig({ CALLBACK_DISPATCH_MODE: "dry_run" }), /requires Sarvam/);
  assert.throws(() => loadConfig({ CALLBACK_DISPATCH_MODE: "live" }), /requires Sarvam/);
});

test("rejects invalid callback mode and app version", () => {
  assert.throws(() => loadConfig({ CALLBACK_DISPATCH_MODE: "automatic" }), /dispatch mode/);
  assert.throws(
    () => loadConfig({ ...completeSarvamEnv, SARVAM_APP_VERSION: "0" }),
    /app version/
  );
});

test("requires HTTPS webhook URL and high-entropy secrets", () => {
  assert.throws(
    () =>
      loadConfig({
        ...completeSarvamEnv,
        SARVAM_WEBHOOK_BASE_URL: "http://example.test/elevate-whatsapp",
      }),
    /HTTPS/
  );
  assert.throws(
    () => loadConfig({ ...completeSarvamEnv, SARVAM_WEBHOOK_TOKEN: "short" }),
    /webhook token/
  );
  assert.throws(
    () => loadConfig({ ...completeSarvamEnv, PHONE_HASH_SALT: "short" }),
    /phone hash salt/
  );
});

test("validates an optional feedback worker token", () => {
  assert.throws(() => loadConfig({ FEEDBACK_WORKER_TOKEN: "short" }), /worker token/);
  assert.equal(
    loadConfig({ FEEDBACK_WORKER_TOKEN: "worker-token-with-at-least-32-characters" })
      .feedbackWorkerToken,
    "worker-token-with-at-least-32-characters"
  );
});
