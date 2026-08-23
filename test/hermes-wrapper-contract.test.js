import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hermes rubric pins the validator's exact JSON contract", async () => {
  const source = await readFile(
    new URL("../worker/hermes_eval.py", import.meta.url),
    "utf8"
  );
  assert.match(source, /Return exactly these top-level keys/);
  assert.match(
    source,
    /"scores", "evidence", "failures", "prompt_delta", "confidence", "insufficient_evidence"/
  );
  assert.match(source, /Evidence objects contain exactly "turn_indexes" and "failure_code"/);
  assert.match(source, /Do not add an interaction id, descriptions, or any other key/);
});
