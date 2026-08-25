#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.js";
import { runFirstCall } from "../src/first-call-runner.js";
import { createSarvamAnalyticsClient } from "../src/sarvam-analytics.js";
import { createSarvamOutboundClient } from "../src/sarvam-outbound.js";

const RECIPIENT_ALIASES = new Set(["controlled_test", "assignment"]);

export function parseArgs(args) {
  if (args.length !== 2) {
    throw new Error("Usage: first-call <controlled_test|assignment> <prospect-name>");
  }
  const [recipientAlias, prospectNameValue] = args;
  const prospectName = prospectNameValue.trim();
  if (!RECIPIENT_ALIASES.has(recipientAlias)) {
    throw new Error("A valid demo recipient alias is required");
  }
  if (!prospectName || prospectName.length > 120) {
    throw new Error("A valid prospect name is required");
  }
  return { recipientAlias, prospectName };
}

async function defaultPostEvent(fetchImpl, url, event) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Bridge replay returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result?.ok) throw new Error("Bridge replay response is invalid");
  return result;
}

export async function run(
  args,
  {
    env = process.env,
    config = loadConfig(env).sarvam,
    outboundClient = config ? createSarvamOutboundClient({ config }) : null,
    analyticsClient = config ? createSarvamAnalyticsClient({ config }) : null,
    fetchImpl = fetch,
    postEvent = (url, event) => defaultPostEvent(fetchImpl, url, event),
    sleep,
    now = () => new Date(),
    stdout = console.log,
  } = {}
) {
  if (!config || !outboundClient || !analyticsClient) {
    throw new Error("Complete Sarvam configuration is required");
  }
  const { recipientAlias, prospectName } = parseArgs(args);
  const request = {
    recipient_alias: recipientAlias,
    prospect_name: prospectName,
    request_id: `first-call:${now().getTime()}:v${config.appVersion}`,
  };
  const result = await runFirstCall({
    request,
    outboundClient,
    analyticsClient,
    postEvent,
    ...(sleep ? { sleep } : {}),
    now,
  });
  const output = {
    ...result,
    appVersion: config.appVersion,
    recipientAlias,
  };
  stdout(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
