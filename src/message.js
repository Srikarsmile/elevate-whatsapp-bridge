import { z } from "zod";

export const ASSIGNMENT_RECIPIENT = "918688664337";
export const CONTROLLED_TEST_RECIPIENT = "918639885985";
export const ALLOWED_RECIPIENTS = Object.freeze([
  ASSIGNMENT_RECIPIENT,
  CONTROLLED_TEST_RECIPIENT,
]);
export const SRIKAR_CONTACT = "+918639885985";

const bounded = z.string().trim().min(1).max(500);

const messageRequestSchema = z
  .object({
    request_id: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    to: z.enum(ALLOWED_RECIPIENTS),
    stage: z.enum(["mid_call", "post_call"]),
    classification: z.enum(["Hot", "Warm", "Cold"]),
    business: bounded.optional(),
    products: bounded.optional(),
    budget: bounded.optional(),
    timeline: bounded.optional(),
    features: bounded.optional(),
    summary: bounded.optional(),
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
    resumePath = null,
    implementationNote = null,
  } = {}
) {
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

  const opening =
    request.stage === "mid_call"
      ? "Thanks for speaking with Priya. Here is the context from our live conversation:"
      : "Thanks for speaking with Priya about your e-commerce website. Here is what I understood:";

  const sections = [opening];
  if (details.length > 0) sections.push(details.join("\n"));
  sections.push(`Lead status: ${request.classification}`);
  sections.push(`WhatsApp or text Srikar at ${SRIKAR_CONTACT}`);

  const attachments = [];
  if (request.stage === "post_call") {
    if (!architectureImagePath) throw new Error("Post-call architecture image is required");
    if (!resumePath) throw new Error("Post-call resume is required");
    const note = implementationNote?.trim();
    if (!note) throw new Error("Post-call implementation note is required");
    if (note.split(/\s+/).length > 200) {
      throw new Error("Post-call implementation note must be at most 200 words");
    }
    sections.push(note);
    attachments.push(
      {
        path: architectureImagePath,
        kind: "image",
        fileName: "elevatebox-architecture.png",
        mimetype: "image/png",
      },
      {
        path: resumePath,
        kind: "document",
        fileName: "Srikar-Reddy-Software-Engineer-CV.pdf",
        mimetype: "application/pdf",
      }
    );
  }

  return {
    text: sections.join("\n\n"),
    attachments,
  };
}
