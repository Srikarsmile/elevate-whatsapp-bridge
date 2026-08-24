import { z } from "zod";

import { assertAllowedRecipient, SRIKAR_CONTACT } from "./phone-policy.js";

export {
  ALLOWED_RECIPIENTS,
  ASSIGNMENT_RECIPIENT,
  CONTROLLED_TEST_RECIPIENT,
  SRIKAR_CONTACT,
} from "./phone-policy.js";

const bounded = z.string().trim().min(1).max(500);
const approvedRecipient = z.string().transform((value, context) => {
  try {
    return assertAllowedRecipient(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid option: recipient is not in the demo allowlist",
    });
    return z.NEVER;
  }
});

const messageRequestSchema = z
  .object({
    request_id: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    to: approvedRecipient,
    stage: z.enum(["mid_call", "post_call"]),
    classification: z.enum(["Hot", "Warm", "Cold"]),
    business: bounded.optional(),
    products: bounded.optional(),
    budget: bounded.optional(),
    timeline: bounded.optional(),
    features: bounded.optional(),
    summary: bounded.optional(),
    language: bounded.optional(),
    quote: bounded.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.stage === "mid_call" && value.classification !== "Hot") {
      context.addIssue({
        code: "custom",
        message: "Mid-call WhatsApp requires Hot classification",
        path: ["classification"],
      });
    }
  });

export function parseMessageRequest(value) {
  return messageRequestSchema.parse(value);
}

export function formatMessage(
  request,
  {
    architectureImagePath = null,
    repositoryUrl = null,
    implementationNote = null,
  } = {}
) {
  const normalizedLanguage = request.language?.toLowerCase() || "";
  const language = normalizedLanguage.includes("telugu")
    ? "telugu"
    : normalizedLanguage.includes("hindi")
      ? "hindi"
      : "english";
  const copy = {
    english: {
      midCall:
        "Thanks for speaking with our website specialist. Here is the context from our live conversation:",
      postCall:
        "Thanks for speaking with our website specialist about your e-commerce website. Here is what I understood:",
      quote: "You said",
      leadStatus: "Lead status",
    },
    telugu: {
      midCall: "మీతో మాట్లాడినందుకు ధన్యవాదాలు. మన సంభాషణలోని ముఖ్యమైన వివరాలు ఇవి:",
      postCall:
        "మీ ఈ-కామర్స్ వెబ్‌సైట్ గురించి మాతో మాట్లాడినందుకు ధన్యవాదాలు. నేను అర్థం చేసుకున్నది ఇది:",
      quote: "మీరు చెప్పింది",
      leadStatus: "లీడ్ స్థితి",
    },
    hindi: {
      midCall: "हमसे बात करने के लिए धन्यवाद। हमारी बातचीत के मुख्य विवरण ये हैं:",
      postCall:
        "अपनी ई-कॉमर्स वेबसाइट के बारे में हमसे बात करने के लिए धन्यवाद। मैंने यह समझा:",
      quote: "आपने कहा",
      leadStatus: "लीड स्थिति",
    },
  }[language];

  const details = [
    ["Business", request.business],
    ["Products", request.products],
    ["Budget", request.budget],
    ["Timeline", request.timeline],
    ["Features", request.features],
    ["Context", request.summary],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);

  const opening = request.stage === "mid_call" ? copy.midCall : copy.postCall;

  const sections = [opening];
  if (request.quote) sections.push(`${copy.quote}: “${request.quote}”`);
  if (details.length > 0) sections.push(details.join("\n"));
  sections.push(`${copy.leadStatus}: ${request.classification}`);
  sections.push(`WhatsApp or text Srikar at ${SRIKAR_CONTACT}`);

  const attachments = [];
  if (request.stage === "post_call") {
    if (!architectureImagePath) throw new Error("Post-call architecture image is required");
    const repository = repositoryUrl?.trim();
    if (!repository) throw new Error("Post-call repository URL is required");
    const note = implementationNote?.trim();
    if (!note) throw new Error("Post-call implementation note is required");
    if (note.split(/\s+/).length > 200) {
      throw new Error("Post-call implementation note must be at most 200 words");
    }
    sections.push(`Repository: ${repository}`);
    sections.push(note);
    attachments.push({
      path: architectureImagePath,
      kind: "image",
      fileName: "elevatebox-architecture.png",
      mimetype: "image/png",
    });
  }

  return {
    text: sections.join("\n\n"),
    attachments,
  };
}
