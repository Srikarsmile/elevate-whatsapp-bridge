import assert from "node:assert/strict";
import test from "node:test";

import { buildPostCallMessageRequest } from "../src/post-call-message.js";

test("preserves the caller language and most informative exact utterance", () => {
  const request = buildPostCallMessageRequest({
    recipientPhone: "918688664337",
    event: {
      event_id: "evt-language-quote",
      final_agent_variables: {
        intent_level: "Hot",
        detected_language: "Hindi-English mixed",
        follow_up_summary: "Needs an apparel store before Diwali",
      },
      transcript: [
        { role: "user", en_text: "Okay" },
        {
          role: "user",
          en_text: "Diwali se pehle apparel website launch karni hai",
        },
        { role: "agent", en_text: "Understood." },
      ],
    },
  });

  assert.equal(request.language, "Hindi-English mixed");
  assert.equal(
    request.quote,
    "Diwali se pehle apparel website launch karni hai"
  );
});
