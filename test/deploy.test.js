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
  assert.match(location, /client_max_body_size 32k/);
  assert.match(location, /limit_req zone=elevate_whatsapp/);
});

test("architecture source documents the implemented flow and contact number", async () => {
  const html = await read("assets/architecture.html");
  assert.match(html, /Automatic Campaign/);
  assert.match(html, /Sarvam Voice Agent/);
  assert.match(html, /Hermes Bridge/);
  assert.match(html, /WhatsApp/);
  assert.match(html, /Callback Booking/);
  assert.match(html, /Resume PDF/);
  assert.match(html, /Architecture PNG/);
  assert.match(html, /\+91 86398 85985/);
});

test("systemd pins callback and final artifact paths in private state", async () => {
  const unit = await read("deploy/elevate-whatsapp-bridge.service");
  assert.match(
    unit,
    /^Environment=CALLBACKS_PATH=\/var\/lib\/elevate-whatsapp-bridge\/callbacks\.json$/m
  );
  assert.match(
    unit,
    /^Environment=RESUME_PATH=\/var\/lib\/elevate-whatsapp-bridge\/assets\/Srikar-Reddy-Software-Engineer-CV\.pdf$/m
  );
});
