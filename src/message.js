import { z } from "zod";

import { assertAllowedRecipient, SRIKAR_CONTACT } from "./phone-policy.js";

export {
  ALLOWED_RECIPIENTS,
  ASSIGNMENT_RECIPIENT,
  CONTROLLED_TEST_RECIPIENT,
  SRIKAR_CONTACT,
} from "./phone-policy.js";

const placeholderPattern = /(?:\[[^\]]+\]|<[^>]+>)/;
const bounded = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !placeholderPattern.test(value), {
    message: "Placeholder values are not allowed",
  });
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
    stage: z.enum(["mid_call", "post_call", "outreach"]),
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

function withPeriod(value) {
  return /[.!?।]$/.test(value) ? value : `${value}.`;
}

function sameStatement(left, right) {
  const normalize = (value) => value?.trim().toLowerCase().replace(/[.!?।]+$/, "");
  return Boolean(left && right && normalize(left) === normalize(right));
}

function naturalContext(request, language) {
  const lines = [];
  if (language === "hindi") {
    if (request.business) {
      lines.push(
        `आप ${request.business} के लिए एक ऑनलाइन स्टोर की योजना बना रहे हैं${
          request.products ? `, जिसमें ${request.products} होंगे` : ""
        }।`
      );
    } else if (request.products) {
      lines.push(`आपके कैटलॉग में ${request.products} होंगे।`);
    }
    if (request.budget && request.timeline) {
      lines.push(`आपने ${request.budget} का बजट और ${request.timeline} की समय-सीमा बताई।`);
    } else if (request.budget) {
      lines.push(`आपने ${request.budget} का बजट बताया।`);
    } else if (request.timeline) {
      lines.push(`आपका लक्ष्य ${request.timeline} है।`);
    }
    if (request.features) lines.push(`हमने इन मुख्य सुविधाओं पर बात की: ${request.features}।`);
    if (request.summary) lines.push(`हमारी बातचीत के अनुसार: ${withPeriod(request.summary)}`);
    if (request.quote && !sameStatement(request.quote, request.summary)) {
      lines.push(`आपने कहा: “${request.quote}”`);
    }
    return lines;
  }

  if (language === "telugu") {
    if (request.business) {
      lines.push(
        `మీరు ${request.business} కోసం ఆన్‌లైన్ స్టోర్ ప్లాన్ చేస్తున్నారు${
          request.products ? `, అందులో ${request.products} ఉంటాయి` : ""
        }.`
      );
    } else if (request.products) {
      lines.push(`మీ కేటలాగ్‌లో ${request.products} ఉంటాయి.`);
    }
    if (request.budget && request.timeline) {
      lines.push(`మీరు ${request.budget} బడ్జెట్ మరియు ${request.timeline} లక్ష్యాన్ని చెప్పారు.`);
    } else if (request.budget) {
      lines.push(`మీరు ${request.budget} బడ్జెట్ చెప్పారు.`);
    } else if (request.timeline) {
      lines.push(`మీ లక్ష్యం ${request.timeline}.`);
    }
    if (request.features) lines.push(`మనం చర్చించిన ప్రధాన ఫీచర్లు: ${request.features}.`);
    if (request.summary) lines.push(`మన సంభాషణ ప్రకారం: ${withPeriod(request.summary)}`);
    if (request.quote && !sameStatement(request.quote, request.summary)) {
      lines.push(`మీరు చెప్పింది: “${request.quote}”`);
    }
    return lines;
  }

  if (request.business) {
    lines.push(
      `You're planning an online store for ${request.business}${
        request.products ? ` with ${request.products}` : ""
      }.`
    );
  } else if (request.products) {
    lines.push(`Your catalogue will have ${request.products}.`);
  }
  if (request.budget && request.timeline) {
    lines.push(`You mentioned a budget of ${request.budget} and a target of ${request.timeline}.`);
  } else if (request.budget) {
    lines.push(`You mentioned a budget of ${request.budget}.`);
  } else if (request.timeline) {
    lines.push(`You're aiming to launch ${request.timeline}.`);
  }
  if (request.features) lines.push(`The main features we discussed were ${request.features}.`);
  if (request.summary) lines.push(`From our conversation: ${withPeriod(request.summary)}`);
  if (request.quote && !sameStatement(request.quote, request.summary)) {
    lines.push(`You said: “${request.quote}”`);
  }
  return lines;
}

function optionalHttpsUrl(value, label) {
  const normalized = value?.trim();
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must be a valid HTTPS URL`);
  return parsed.toString().replace(/\/$/, "");
}

export function formatMessage(
  request,
  {
    architectureImagePath = null,
    previewUrl = null,
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
      midCall: "Thanks for speaking with me. Here is a quick recap of our conversation:",
      postCall: "Thanks for speaking with me about your e-commerce website.",
      outreach:
        "Hi ElevateBox team. I tried reaching you by phone, but the call did not connect. I'm sharing the working prototype details here.",
      preview: "Live preview",
      repository: "Source code",
      contact: "WhatsApp or text Srikar at",
      architecture:
        "I've attached the Mermaid architecture showing how the call, WhatsApp actions, callbacks, website generation, and Vercel deployment work together.",
      buildNote: "Build note",
    },
    telugu: {
      midCall: "మీతో మాట్లాడినందుకు ధన్యవాదాలు. మన సంభాషణలోని ముఖ్యమైన వివరాలు ఇవి:",
      postCall:
        "మీ ఈ-కామర్స్ వెబ్‌సైట్ గురించి మాతో మాట్లాడినందుకు ధన్యవాదాలు. నేను అర్థం చేసుకున్నది ఇది:",
      outreach:
        "నమస్కారం ElevateBox బృందం. ఫోన్‌లో సంప్రదించడానికి ప్రయత్నించాను, కానీ కాల్ కనెక్ట్ కాలేదు. పనిచేస్తున్న నమూనా వివరాలు ఇక్కడ పంపుతున్నాను.",
      preview: "లైవ్ ప్రివ్యూ",
      repository: "సోర్స్ కోడ్",
      contact: "Srikarకి WhatsApp లేదా టెక్స్ట్ చేయండి",
      architecture:
        "కాల్, WhatsApp చర్యలు, కాల్‌బ్యాక్‌లు, వెబ్‌సైట్ నిర్మాణం మరియు Vercel డిప్లాయ్‌మెంట్ కలిసి ఎలా పనిచేస్తాయో చూపించే Mermaid ఆర్కిటెక్చర్‌ను జత చేశాను.",
      buildNote: "బిల్డ్ నోట్",
    },
    hindi: {
      midCall: "हमसे बात करने के लिए धन्यवाद। हमारी बातचीत के मुख्य विवरण ये हैं:",
      postCall:
        "अपनी ई-कॉमर्स वेबसाइट के बारे में हमसे बात करने के लिए धन्यवाद। मैंने यह समझा:",
      outreach:
        "नमस्ते ElevateBox टीम। मैंने फ़ोन पर संपर्क करने की कोशिश की, लेकिन कॉल कनेक्ट नहीं हुई। मैं काम कर रहे प्रोटोटाइप का विवरण यहाँ भेज रहा हूँ।",
      preview: "लाइव प्रीव्यू",
      repository: "सोर्स कोड",
      contact: "Srikar को WhatsApp या टेक्स्ट करें",
      architecture:
        "मैंने Mermaid आर्किटेक्चर संलग्न किया है, जिसमें कॉल, WhatsApp कार्रवाइयां, कॉलबैक, वेबसाइट निर्माण और Vercel डिप्लॉयमेंट का पूरा प्रवाह दिखाया गया है।",
      buildNote: "बिल्ड नोट",
    },
  }[language];

  const opening =
    request.stage === "mid_call"
      ? copy.midCall
      : request.stage === "outreach"
        ? copy.outreach
        : copy.postCall;
  const sections = [opening];
  const context =
    request.stage === "outreach" && request.summary
      ? [withPeriod(request.summary)]
      : naturalContext(request, language);
  if (context.length > 0) sections.push(context.join(" "));

  const attachments = [];
  if (request.stage === "post_call" || request.stage === "outreach") {
    if (!architectureImagePath) throw new Error("Post-call architecture image is required");
    const repository = repositoryUrl?.trim();
    if (!repository) throw new Error("Post-call repository URL is required");
    const note = implementationNote?.trim();
    if (!note) throw new Error("Post-call implementation note is required");
    if (note.split(/\s+/).length > 200) {
      throw new Error("Post-call implementation note must be at most 200 words");
    }
    const preview = optionalHttpsUrl(previewUrl, "Post-call preview URL");
    const links = [];
    if (preview) links.push(`${copy.preview}: ${preview}`);
    links.push(`${copy.repository}: ${repository}`);
    sections.push(links.join("\n"));
    sections.push(`${copy.contact} ${SRIKAR_CONTACT}`);
    sections.push(copy.architecture);
    sections.push(`${copy.buildNote}: ${note}`);
    attachments.push({
      path: architectureImagePath,
      kind: "image",
      fileName: "elevatebox-architecture.png",
      mimetype: "image/png",
    });
  } else {
    sections.push(`${copy.contact} ${SRIKAR_CONTACT}`);
  }

  return {
    text: sections.join("\n\n"),
    attachments,
  };
}
