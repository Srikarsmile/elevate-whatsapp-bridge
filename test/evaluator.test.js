import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateDeterministically } from "../src/evaluator.js";

const fixtureNames = [
  "good-concise",
  "missed-booking",
  "stored-not-dispatched",
  "stacked-questions",
  "repeated-acknowledgements",
  "consecutive-agent-turns",
  "interruption-without-timing",
];

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`fixtures/calls/${name}.json`, import.meta.url), "utf8")
  );
}

test("regression fixtures produce their declared deterministic findings", async () => {
  for (const name of fixtureNames) {
    const value = await fixture(name);
    const result = evaluateDeterministically(value);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      value.expected.finding_codes,
      name
    );
    assert.equal(result.score, value.expected.score, name);
    assert.equal(result.interruption, value.expected.interruption, name);
  }
});

test("applies stable conversational deductions and numeric-only evidence", () => {
  const longTurn = Array.from({ length: 46 }, (_, index) => `word${index}`).join(" ");
  const result = evaluateDeterministically({
    event: {
      transcript: [
        { role: "agent", en_text: `${longTurn}? Another question?` },
        { role: "agent", en_text: "Understood. Understood." },
        { role: "user", en_text: "Fine." },
      ],
      final_agent_variables: {
        business: "fictional retail",
        products: "catalogue",
        features: "checkout",
        budget: "unknown",
        timeline: "month",
        decision_maker: "owner",
        intent: "warm",
      },
      tool_results: [],
      received_at: "2026-08-23T05:00:00.000Z",
    },
    callback: null,
  });

  assert.equal(result.score, 45);
  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    [
      "long_agent_turn",
      "stacked_questions",
      "consecutive_agent_turns",
      "repeated_sentence",
      "agent_user_word_ratio",
    ]
  );
  assert.deepEqual(result.findings[0].turn_indexes, [0]);
  assert.equal(result.findings[0].evidence.word_count, 48);
  assert.doesNotMatch(JSON.stringify(result.findings), /Understood|word0/);
});

test("accepts the deployed Sarvam output variable names as complete discovery", () => {
  const result = evaluateDeterministically({
    event: {
      transcript: [
        { role: "agent", en_text: "What does your shop sell?" },
        { role: "user", en_text: "Handmade clothing." },
      ],
      final_agent_variables: {
        business_type: "fashion retail",
        product_count: "about 80",
        required_features: "catalogue and checkout",
        budget_range: "around 60000 rupees",
        launch_timeline: "next month",
        decision_maker: "owner",
        intent_level: "Warm",
      },
      tool_results: [],
      received_at: "2026-08-23T05:00:00.000Z",
    },
  });

  assert.equal(result.metrics.missing_required_variables, 0);
  assert.ok(!result.findings.some((finding) => finding.code === "missing_required_variables"));
});

test("caps repeated deductions and floors the score at zero", () => {
  const transcript = [];
  for (let index = 0; index < 5; index += 1) {
    transcript.push({
      role: "agent",
      en_text: `${"word ".repeat(46)}? First? Second? Same sentence. Same sentence.`,
    });
  }
  const result = evaluateDeterministically({
    event: {
      transcript,
      final_agent_variables: { callback_requested: true, tool_action_promised: true },
      tool_results: [],
      received_at: "2026-08-23T05:00:00.000Z",
    },
    callback: null,
  });
  assert.equal(result.score, 0);
  assert.equal(
    result.findings.filter((finding) => finding.code === "long_agent_turn").length,
    3
  );
  assert.equal(
    result.findings.filter((finding) => finding.code === "stacked_questions").length,
    2
  );
  assert.equal(
    result.findings.filter((finding) => finding.code === "repeated_sentence").length,
    2
  );
});

test("does not infer callback intent from prose and marks absent transcripts insufficient", () => {
  const proseOnly = evaluateDeterministically({
    event: {
      transcript: [
        { role: "user", en_text: "Please call me later." },
        { role: "agent", en_text: "I can help with that." },
      ],
      final_agent_variables: {},
      tool_results: [],
      received_at: "2026-08-23T05:00:00.000Z",
    },
  });
  assert.ok(!proseOnly.findings.some((finding) => finding.code === "callback_not_booked"));
  assert.equal(proseOnly.insufficientEvidence, false);

  const noTranscript = evaluateDeterministically({
    event: {
      transcript: null,
      final_agent_variables: null,
      tool_results: [],
      received_at: "2026-08-23T05:00:00.000Z",
    },
  });
  assert.equal(noTranscript.insufficientEvidence, true);
  assert.equal(noTranscript.interruption, "not_scoreable");
});
