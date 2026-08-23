const REQUIRED_VARIABLES = Object.freeze([
  ["business", "business_type"],
  ["products", "product_count"],
  ["features", "required_features"],
  ["budget", "budget_range"],
  ["timeline", "launch_timeline"],
  ["decision_maker"],
  ["intent", "intent_level"],
]);

function wordCount(text) {
  return String(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length || 0;
}

function normalizedSentences(text) {
  return String(text)
    .split(/[.!?]+/)
    .map((sentence) =>
      sentence
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    )
    .filter(Boolean);
}

function finding(code, severity, turnIndexes, evidence, deduction) {
  return Object.freeze({
    code,
    severity,
    turn_indexes: Object.freeze([...turnIndexes]),
    evidence: Object.freeze({ ...evidence }),
    deduction,
  });
}

function hasTimingEvidence(transcript) {
  return transcript.some(
    (turn) =>
      Number.isFinite(turn.start_ms) ||
      Number.isFinite(turn.end_ms) ||
      typeof turn.overlap === "boolean"
  );
}

function callbackSignals(event, callback) {
  const variables = event.final_agent_variables || {};
  const toolResults = Array.isArray(event.tool_results) ? event.tool_results : [];
  const scheduleResults = toolResults.filter((result) => result.name === "schedule_callback");
  const successfulSchedule = scheduleResults.some(
    (result) => result.status === "success" && result.booking_id
  );
  return {
    callbackRequested: variables.callback_requested === true || scheduleResults.length > 0,
    callbackCreated: Boolean(callback) || successfulSchedule,
    toolPromised:
      variables.tool_action_promised === true ||
      typeof variables.tool_action_promised === "string",
    toolSucceeded: toolResults.some((result) => result.status === "success"),
  };
}

export function evaluateDeterministically({ event, callback = null }) {
  if (!event || typeof event !== "object") throw new Error("Call event is required");
  const transcript = Array.isArray(event.transcript) ? event.transcript : [];
  const findings = [];
  let deductions = 0;

  let longTurnCount = 0;
  let stackedQuestionCount = 0;
  let consecutiveAgentCount = 0;
  let repeatedSentenceCount = 0;
  let agentWords = 0;
  let userWords = 0;
  const seenAgentSentences = new Map();

  transcript.forEach((turn, turnIndex) => {
    const words = wordCount(turn.en_text);
    if (turn.role === "agent") {
      agentWords += words;
      if (words > 45 && longTurnCount < 3) {
        findings.push(
          finding("long_agent_turn", "medium", [turnIndex], { word_count: words }, 8)
        );
        deductions += 8;
        longTurnCount += 1;
      }

      const questionCount = (String(turn.en_text).match(/\?/g) || []).length;
      if (questionCount > 1 && stackedQuestionCount < 2) {
        findings.push(
          finding(
            "stacked_questions",
            "medium",
            [turnIndex],
            { question_count: questionCount },
            10
          )
        );
        deductions += 10;
        stackedQuestionCount += 1;
      }

      const previous = transcript[turnIndex - 1];
      if (previous?.role === "agent" && wordCount(previous.en_text) > 0) {
        findings.push(
          finding(
            "consecutive_agent_turns",
            "high",
            [turnIndex - 1, turnIndex],
            { consecutive_turn_count: 2 },
            15
          )
        );
        deductions += 15;
        consecutiveAgentCount += 1;
      }

      for (const sentence of normalizedSentences(turn.en_text)) {
        const previousIndex = seenAgentSentences.get(sentence);
        if (previousIndex !== undefined && repeatedSentenceCount < 2) {
          findings.push(
            finding(
              "repeated_sentence",
              "medium",
              [previousIndex, turnIndex],
              { occurrence_count: 2 },
              10
            )
          );
          deductions += 10;
          repeatedSentenceCount += 1;
        } else if (previousIndex === undefined) {
          seenAgentSentences.set(sentence, turnIndex);
        }
      }
    } else if (turn.role === "user") {
      userWords += words;
    }
  });

  const totalWords = agentWords + userWords;
  const wordRatio = userWords === 0 ? null : agentWords / userWords;
  if (totalWords >= 20 && (userWords === 0 || wordRatio > 1.8)) {
    findings.push(
      finding(
        "agent_user_word_ratio",
        "medium",
        [],
        {
          agent_words: agentWords,
          user_words: userWords,
          ratio_hundredths: userWords === 0 ? 10_000 : Math.round(wordRatio * 100),
        },
        12
      )
    );
    deductions += 12;
  }

  const signals = callbackSignals(event, callback);
  if (signals.callbackRequested && !signals.callbackCreated) {
    findings.push(
      finding("callback_not_booked", "critical", [], { booking_count: 0 }, 40)
    );
    deductions += 40;
  }

  const eventTime = Date.parse(event.received_at || "");
  const callbackTime = Date.parse(callback?.callback_time_iso || "");
  const dueLiveCallback =
    callback?.dispatch_mode === "live" &&
    Number.isFinite(eventTime) &&
    Number.isFinite(callbackTime) &&
    callbackTime <= eventTime;
  if (dueLiveCallback && !event.attempt_id && !callback.attempt_id) {
    findings.push(
      finding(
        "due_callback_not_dispatched",
        "critical",
        [],
        { overdue_seconds: Math.max(0, Math.floor((eventTime - callbackTime) / 1000)) },
        50
      )
    );
    deductions += 50;
  }

  if (signals.toolPromised && !signals.toolSucceeded) {
    findings.push(
      finding("tool_promise_without_success", "high", [], { success_count: 0 }, 30)
    );
    deductions += 30;
  }

  const variables = event.final_agent_variables || {};
  const missingVariables = REQUIRED_VARIABLES.filter((aliases) =>
    aliases.every(
      (name) =>
        variables[name] === null || variables[name] === undefined || variables[name] === ""
    )
  );
  if (missingVariables.length > 0) {
    const missingCount = Math.min(missingVariables.length, 6);
    findings.push(
      finding(
        "missing_required_variables",
        "low",
        [],
        { missing_count: missingVariables.length },
        missingCount * 4
      )
    );
    deductions += missingCount * 4;
  }

  return Object.freeze({
    score: Math.max(0, 100 - deductions),
    findings: Object.freeze(findings),
    interruption: hasTimingEvidence(transcript) ? "scoreable" : "not_scoreable",
    metrics: Object.freeze({
      agent_words: agentWords,
      user_words: userWords,
      total_words: totalWords,
      long_agent_turns: longTurnCount,
      stacked_question_turns: stackedQuestionCount,
      consecutive_agent_turns: consecutiveAgentCount,
      repeated_sentences: repeatedSentenceCount,
      missing_required_variables: missingVariables.length,
    }),
    insufficientEvidence:
      transcript.length === 0 ||
      !transcript.some((turn) => turn.role === "agent") ||
      !transcript.some((turn) => turn.role === "user"),
  });
}
