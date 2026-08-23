import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_RECIPIENTS,
  assertAllowedRecipient,
  hashPhone,
  normalizeIndianPhone,
  redactPhone,
} from "../src/phone-policy.js";

test("normalizes supported Indian mobile formats", () => {
  assert.equal(normalizeIndianPhone("+91 86398 85985"), "918639885985");
  assert.equal(normalizeIndianPhone("91-86886-64337"), "918688664337");
  assert.equal(normalizeIndianPhone("(86398) 85985"), "918639885985");
});

test("rejects malformed and non-mobile phone values", () => {
  assert.throws(() => normalizeIndianPhone("+44 7700 900123"), /Indian mobile/);
  assert.throws(() => normalizeIndianPhone("5111111111"), /Indian mobile/);
  assert.throws(() => normalizeIndianPhone("86398/85985"), /Indian mobile/);
  assert.throws(() => normalizeIndianPhone(null), /Indian mobile/);
});

test("allows exactly the two approved demo recipients", () => {
  assert.deepEqual(ALLOWED_RECIPIENTS, ["918688664337", "918639885985"]);
  assert.equal(assertAllowedRecipient("+91-86886-64337"), "918688664337");
  assert.throws(() => assertAllowedRecipient("+91 99999 99999"), /allowlist/);
});

test("redacts all but the last four digits", () => {
  assert.equal(redactPhone("918639885985"), "********5985");
});

test("hashes normalized phones deterministically with a keyed salt", () => {
  const first = hashPhone("918639885985", "test-salt");
  const formatted = hashPhone("+91 86398 85985", "test-salt");
  const otherSalt = hashPhone("918639885985", "other-salt");

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, formatted);
  assert.notEqual(first, otherSalt);
});
