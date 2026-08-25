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

test("normalizes a formatted approved message recipient", () => {
  const request = { ...validMidCall, to: "+91 86398 85985" };
  assert.deepEqual(parseMessageRequest(request), {
    ...request,
    to: "918639885985",
  });
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

test("rejects placeholder values before they can reach WhatsApp", () => {
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, budget: "[budget from call]" }),
    /placeholder/i
  );
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, features: "<features discussed>" }),
    /placeholder/i
  );
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, summary: "Budget is [pending]" }),
    /placeholder/i
  );
});

test("rejects a non-Hot mid-call request", () => {
  assert.throws(
    () => parseMessageRequest({ ...validMidCall, classification: "Warm" }),
    /Mid-call WhatsApp requires Hot classification/
  );
});

test("formats a truthful outreach package when the call did not connect", () => {
  const request = parseMessageRequest({
    request_id: "assignment-outreach-20260825",
    to: "918688664337",
    stage: "outreach",
    classification: "Cold",
    summary:
      "The prototype handles multilingual discovery, intent classification, WhatsApp actions, callbacks, and tailored website previews deployed to Vercel",
    language: "English",
  });

  const result = formatMessage(request, {
    architectureImagePath: "/private/architecture.png",
    previewUrl: "https://preview.example.test",
    repositoryUrl: "https://github.com/example/prototype",
    implementationNote: "The call provider failed before connection; the system remains ready.",
  });

  assert.match(result.text, /tried reaching you by phone, but the call did not connect/i);
  assert.doesNotMatch(result.text, /Thanks for speaking with me/i);
  assert.match(result.text, /https:\/\/github.com\/example\/prototype/);
  assert.match(result.text, /\+918639885985/);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].kind, "image");
});

test("formats captured facts as natural prose and includes Srikar's contact number", () => {
  const request = parseMessageRequest({
    request_id: "call-456:mid-call",
    to: "918688664337",
    stage: "mid_call",
    classification: "Hot",
    business: "books",
    budget: "around 60000 rupees",
  });

  const result = formatMessage(request, {
    architectureImagePath: "/private/architecture.png",
  });

  assert.match(result.text, /planning an online store for books/);
  assert.match(result.text, /budget of around 60000 rupees/);
  assert.doesNotMatch(result.text, /Timeline:/);
  assert.doesNotMatch(result.text, /Lead status|Hot|Warm|Cold/);
  assert.match(result.text, /WhatsApp or text Srikar at \+918639885985/);
  assert.deepEqual(result.attachments, []);
});

test("uses the caller language and quotes their exact words", () => {
  const request = parseMessageRequest({
    ...validMidCall,
    language: "Telugu-English mixed",
    quote: "పండుగకు ముందు launch చేయాలి",
  });

  const result = formatMessage(request);

  assert.match(result.text, /మీతో మాట్లాడినందుకు ధన్యవాదాలు/);
  assert.match(result.text, /మీరు చెప్పింది: “పండుగకు ముందు launch చేయాలి”/);
  assert.doesNotMatch(result.text, /లీడ్ స్థితి|Hot|Warm|Cold/);
  assert.match(result.text, /\+918639885985/);
});

test("adds the Mermaid architecture and repository without attaching a resume", () => {
  const request = parseMessageRequest({
    request_id: "call-789:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Warm",
    summary: "Interested after a partner discussion",
  });

  const result = formatMessage(request, {
    architectureImagePath: "/private/architecture.png",
    previewUrl: "https://preview.example.test",
    repositoryUrl: "https://github.com/Srikarsmile/elevate-whatsapp-bridge",
    implementationNote:
      "The live Sarvam agent qualifies the lead while Hermes handles WhatsApp and callback actions. The linked WhatsApp transport is experimental; Meta Cloud API is the production replacement.",
  });

  assert.match(result.text, /Thanks for speaking with me about your e-commerce website/);
  assert.doesNotMatch(result.text, /Priya/);
  assert.doesNotMatch(result.text, /Lead status|Hot|Warm|Cold/);
  assert.match(result.text, /From our conversation: Interested after a partner discussion\./);
  assert.match(result.text, /Live preview: https:\/\/preview\.example\.test/);
  assert.match(result.text, /Build note: The live Sarvam agent qualifies the lead/);
  assert.match(
    result.text,
    /https:\/\/github\.com\/Srikarsmile\/elevate-whatsapp-bridge/
  );
  assert.deepEqual(result.attachments, [
    {
      path: "/private/architecture.png",
      kind: "image",
      fileName: "elevatebox-architecture.png",
      mimetype: "image/png",
    },
  ]);
  assert.doesNotMatch(result.text, /\[[^\]]+\]|<[^>]+>/);
});

test("rejects a post-call follow-up without the architecture artifact", () => {
  const request = parseMessageRequest({
    request_id: "call-790:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Cold",
  });

  assert.throws(
    () =>
      formatMessage(request, {
        repositoryUrl: "https://github.com/Srikarsmile/elevate-whatsapp-bridge",
        implementationNote: "Working demo note.",
      }),
    /architecture/i
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
        repositoryUrl: "https://github.com/Srikarsmile/elevate-whatsapp-bridge",
        implementationNote: Array.from({ length: 201 }, () => "word").join(" "),
      }),
    /200 words/
  );
});

test("does not require a resume but still requires the repository", () => {
  const request = parseMessageRequest({
    request_id: "call-792:post-call",
    to: "918688664337",
    stage: "post_call",
    classification: "Hot",
  });
  const base = {
    architectureImagePath: "/private/architecture.png",
    implementationNote: "Working demo note.",
  };

  assert.throws(
    () => formatMessage(request, base),
    /repository/i
  );
  const result = formatMessage(request, {
    ...base,
    repositoryUrl: "https://github.com/Srikarsmile/elevate-whatsapp-bridge",
  });
  assert.deepEqual(result.attachments.map(({ kind }) => kind), ["image"]);
});
