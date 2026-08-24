import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("systemd unit runs unprivileged with a restricted writable state directory", async () => {
  const unit = await read("deploy/elevate-whatsapp-bridge.service");
  assert.match(unit, /^User=elevate-wa$/m);
  assert.match(unit, /^Group=elevate-wa$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/elevate-whatsapp-bridge$/m);
  assert.match(unit, /^UMask=0077$/m);
});

test("nginx route keeps the bridge local, bounded and rate limited", async () => {
  const httpConfig = await read("deploy/nginx-http.conf");
  const location = await read("deploy/nginx-location.conf");
  assert.match(httpConfig, /limit_req_zone .*zone=elevate_whatsapp:/);
  assert.match(location, /location \/elevate-whatsapp\//);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:3218\//);
  assert.match(location, /client_max_body_size 256k/);
  assert.match(location, /limit_req zone=elevate_whatsapp/);
  assert.match(location, /access_log off;/);
  const internalIndex = location.indexOf("location ^~ /elevate-whatsapp/v1/internal/");
  const proxyIndex = location.indexOf("location /elevate-whatsapp/");
  assert.ok(internalIndex >= 0 && internalIndex < proxyIndex);
  assert.match(location, /location \^~ \/elevate-whatsapp\/v1\/internal\/ \{\s*return 404;/);
});

test("Mermaid architecture documents runtime, preview, and self-improvement gates", async () => {
  const diagram = await read("assets/architecture.mmd");
  assert.match(diagram, /^flowchart LR/m);
  assert.match(diagram, /Sarvam Voice Agent/);
  assert.match(diagram, /Callback Scheduler/);
  assert.match(diagram, /Instant Outbound/);
  assert.match(diagram, /Website Preview Builder/);
  assert.match(diagram, /Vercel Deployment/);
  assert.match(diagram, /Live Preview URL/);
  assert.match(diagram, /Deterministic Evaluator/);
  assert.match(diagram, /Tool-free Hermes/);
  assert.match(diagram, /Regression Evidence Gate/);
  assert.match(diagram, /Human Approval Gate/);
  assert.match(diagram, /Manual Promotion Gate/);
  assert.match(diagram, /No Direct Self-Edit/);
  assert.match(diagram, /External Deployment Gate/);
  assert.match(diagram, /WhatsApp/);
  assert.match(diagram, /Mermaid-rendered architecture/);
  assert.doesNotMatch(diagram, /resume/i);
  assert.match(diagram, /repository/);
  assert.match(diagram, /\+91 86398 85985/);
  assert.doesNotMatch(diagram, /Priya/);
});

test("systemd pins every bridge state path and defaults callback dispatch to disabled", async () => {
  const unit = await read("deploy/elevate-whatsapp-bridge.service");
  for (const [key, file] of [
    ["CALLBACKS_PATH", "callbacks.json"],
    ["OUTBOUND_EVENTS_PATH", "outbound-events.json"],
    ["EVALUATION_JOBS_PATH", "evaluation-jobs.json"],
    ["FEEDBACK_PATH", "feedback.json"],
    ["EVALUATION_CASES_PATH", "evaluation-cases.json"],
    ["RECOMMENDATIONS_PATH", "recommendations.json"],
  ]) {
    assert.match(
      unit,
      new RegExp(`^Environment=${key}=/var/lib/elevate-whatsapp-bridge/${file}$`, "m")
    );
  }
  assert.ok(
    unit.indexOf("Environment=CALLBACK_DISPATCH_MODE=disabled") <
      unit.indexOf("EnvironmentFile=/etc/elevate-whatsapp-bridge.env")
  );
  assert.doesNotMatch(unit, /^Environment=CALLBACK_DISPATCH_MODE=live$/m);
  assert.doesNotMatch(unit, /^Environment=RESUME_PATH=/m);
  assert.match(
    unit,
    /^Environment=REPOSITORY_URL=https:\/\/github\.com\/Srikarsmile\/elevate-whatsapp-bridge$/m
  );
});

test("feedback worker runs as a separate hardened identity", async () => {
  const unit = await read("deploy/elevate-feedback-worker.service");
  assert.match(unit, /^User=elevate-feedback$/m);
  assert.match(unit, /^Group=elevate-feedback$/m);
  assert.doesNotMatch(unit, /^User=(root|elevate-wa)$/m);
  assert.match(unit, /^WorkingDirectory=\/var\/empty\/elevate-feedback-worker$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  assert.match(unit, /^PrivateTmp=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/elevate-feedback-worker$/m);
  assert.doesNotMatch(unit, /CALLBACK_DISPATCH_MODE=live/);
});

test("worker environment example names settings without containing secrets", async () => {
  const example = await read("deploy/elevate-feedback-worker.env.example");
  assert.match(example, /^FEEDBACK_BRIDGE_URL=http:\/\/127\.0\.0\.1:3218$/m);
  assert.match(example, /^FEEDBACK_WORKER_TOKEN=$/m);
  assert.match(example, /^HERMES_EVAL_MODEL=gpt-5\.6-sol$/m);
  assert.match(example, /^HERMES_EVAL_PROVIDER=openai-codex$/m);
  assert.doesNotMatch(example, /sk-|Bearer |[a-f0-9]{32,}/i);
});

test("runbook documents no-call gates, feedback approval, and neutral agent wording", async () => {
  const runbook = await read("docs/demo-runbook.md");
  assert.match(runbook, /918639885985/);
  assert.match(runbook, /918688664337/);
  assert.match(runbook, /CALLBACK_DISPATCH_MODE=disabled/);
  assert.match(runbook, /dry_run/);
  assert.match(runbook, /dispatch_unknown/);
  assert.match(runbook, /human approval/i);
  assert.match(runbook, /Mermaid-rendered architecture/i);
  assert.doesNotMatch(runbook, /resume/i);
  assert.match(runbook, /repository/i);
  assert.match(runbook, /30 days/);
  assert.doesNotMatch(runbook, /Priya/);
});

test("service entry point wires persistent callback and feedback processing", async () => {
  const source = await read("src/index.js");
  assert.match(source, /loadConfig/);
  assert.match(source, /createCallbackScheduler/);
  assert.match(source, /createEventProcessor/);
  assert.match(source, /createEvaluationQueue/);
  assert.match(source, /createFeedbackLoop/);
  assert.match(source, /callbackScheduler\.start/);
  assert.match(source, /eventProcessor\.start/);
});
