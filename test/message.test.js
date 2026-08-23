import assert from "node:assert/strict";
import test from "node:test";

import { formatMessage, parseMessageRequest } from "../src/message.js";

const validMidCall = {
  request_id: "call-123:mid-call",
  to: "918688664337",
  stage: "mid_call",
  classification: "Hot",
  business: "handmade clothing",
  products: "about 80",
  budget: "around 60000 rupees",
  timeline: "next month",
  features: "catalog, UPI payments and WhatsApp support",
  summary: "Wants to launch before the festival season",
};

test("accepts a valid Hot mid-call request", () => {
  assert.deepEqual(parseMessageRequest(validMidCall), validMidCall);
});

test("accepts the controlled test recipient", () => {
  const request = { ...validMidCall, to: "918639885985" };
  assert.deepEqual(parseMessageRequest(request), request);
});

test("rejects destinations outside the demo allowlist", () => {
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, to: "919999999999" }),
    /Invalid option/
  );
});

test("rejects unknown request fields", () => {
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, raw_message: "arbitrary text" }),
    /Unrecognized key/
  );
});

test("rejects a non-Hot mid-call request", () => {
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, classification: "Warm" }),
    /Mid-call WhatsApp requires Hot classification/
  );
});

test("formats captured facts and always includes Srikar's contact number", () => {
  const request = parseMessageRequest({
    request_id: "call-456:mid-call",
    to: "918688664337",
    stage: "mid_call",
    classification: "Hot",
    business: "books",
    budget: "not discussed",
  });

  const result = formatMessage(request, {
    architectureImagePath: "/private/architecture.png",
  });

  assert.match(result.text, /Business: books/);
  assert.match(result.text, /Budget: not discussed/);
  assert.doesNotMatch(result.text, /Timeline:/);
  assert.match(result.text, /WhatsApp or text Srikar at \+918639885985/);
  assert.deepEqual(result.attachments, []);
});

test("adds the required architecture and resume artifacts to a post-call follow-up", () => {
  const request = parseMessageRequest({
    request_id: "call-789:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Warm",
    summary: "Interested after a partner discussion",
  });

  const result = formatMessage(request, {
    architectureImagePath: "/private/architecture.png",
    resumePath: "/private/resume.pdf",
    implementationNote:
      "The live Sarvam agent qualifies the lead while Hermes handles WhatsApp and callback actions. The linked WhatsApp transport is experimental; Meta Cloud API is the production replacement.",
  });

  assert.match(result.text, /Thanks for speaking with Priya/);
  assert.match(result.text, /Lead status: Warm/);
  assert.match(result.text, /live Sarvam agent qualifies the lead/);
  assert.deepEqual(result.attachments, [
    {
      path: "/private/architecture.png",
      kind: "image",
      fileName: "elevatebox-architecture.png",
      mimetype: "image/png",
    },
    {
      path: "/private/resume.pdf",
      kind: "document",
      fileName: "Srikar-Reddy-Software-Engineer-CV.pdf",
      mimetype: "application/pdf",
    },
  ]);
});

test("rejects an incomplete post-call artifact package", () => {
  const request = parseMessageRequest({
    request_id: "call-790:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Cold",
  });

  assert.throws(
    () =>
      formatMessage(request, {
        architectureImagePath: "/private/architecture.png",
        implementationNote: "Working demo note.",
      }),
    /resume/i
  );
});

test("rejects a post-call implementation note over 200 words", () => {
  const request = parseMessageRequest({
    request_id: "call-791:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Hot",
  });

  assert.throws(
    () =>
      formatMessage(request, {
        architectureImagePath: "/private/architecture.png",
        resumePath: "/private/resume.pdf",
        implementationNote: Array.from({ length: 201 }, () => "word").join(" "),
      }),
    /200 words/
  );
});
