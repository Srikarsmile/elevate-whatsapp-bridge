#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const RECOMMENDATION_ID = /^rec-[a-f0-9]{24}$/;

function requireRecommendationId(value) {
  if (!RECOMMENDATION_ID.test(value || "")) {
    throw new Error("A valid recommendation ID is required");
  }
  return value;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

function commandRequest(args) {
  const [command, id] = args;
  if (command === "list" && args.length === 1) {
    return { path: "/v1/recommendations", method: "GET" };
  }
  if (command === "show" && args.length === 2) {
    return {
      path: `/v1/recommendations/${requireRecommendationId(id)}`,
      method: "GET",
    };
  }
  if (command === "approve" && args.length === 2) {
    return {
      path: `/v1/recommendations/${requireRecommendationId(id)}/approve`,
      method: "POST",
      body: {},
    };
  }
  if (command === "reject" && args.length === 4 && args[2] === "--reason") {
    return {
      path: `/v1/recommendations/${requireRecommendationId(id)}/reject`,
      method: "POST",
      body: { reason: flagValue(args, "--reason") },
    };
  }
  if (
    command === "promote" &&
    args.length === 6 &&
    args.includes("--version") &&
    args.includes("--fixtures")
  ) {
    const version = Number.parseInt(flagValue(args, "--version"), 10);
    const fixtureIds = flagValue(args, "--fixtures")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!Number.isInteger(version) || version <= 0 || fixtureIds.length === 0) {
      throw new Error("Promotion version and fixtures are invalid");
    }
    return {
      path: `/v1/recommendations/${requireRecommendationId(id)}/promote`,
      method: "POST",
      body: { version, fixture_ids: fixtureIds },
    };
  }
  throw new Error("Unknown or invalid recommendations command");
}

export async function run(
  args,
  { env = process.env, fetchImpl = fetch, stdout = console.log } = {}
) {
  const secret = env.BRIDGE_SECRET;
  if (typeof secret !== "string" || secret.length < 24) {
    throw new Error("BRIDGE_SECRET is required");
  }
  const baseUrl = (env.BRIDGE_BASE_URL || "http://127.0.0.1:3218").replace(/\/+$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsedBaseUrl.hostname)) {
    throw new Error("BRIDGE_BASE_URL must be loopback-only");
  }
  const request = commandRequest(args);
  const response = await fetchImpl(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
  const result = await response.json();
  stdout(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
