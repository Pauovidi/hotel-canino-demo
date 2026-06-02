import { getFaqEntry, resolveFaqQuery } from "@/lib/hotel/faq";
import type { FaqIntentId, FaqResolution } from "@/lib/hotel/faq";

export const UNCOVERED_CONCRETE_QUESTION_REPLY =
  "Disculpa, para esta información un miembro de nuestro equipo se pondrá en contacto contigo para aclarar esta cuestión.";

export interface MatchedHotelFaq {
  intent: FaqIntentId;
  reply: string;
  resolution: FaqResolution;
  isFallback: boolean;
}

function normalizeKnowledgeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;:()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isConcreteKnowledgeQuestion(message: string): boolean {
  const normalized = normalizeKnowledgeText(message);
  if (!normalized) {
    return false;
  }

  return (
    /[¿?]/.test(message) ||
    /^(y\s+)?(que|como|cuando|donde|cuanto|puedo|hay|teneis|tenéis|tiene|se\s+puede)\b/.test(
      normalized,
    ) ||
    /^y\s+(el|la|los|las)\s+\w+/.test(normalized)
  );
}

export function matchFaqIntent(message: string): MatchedHotelFaq | undefined {
  const resolution = resolveFaqQuery(message);

  if (resolution.outputType === "workflow") {
    return undefined;
  }

  if (resolution.usedFallback) {
    return isConcreteKnowledgeQuestion(message)
      ? {
          intent: resolution.intent,
          reply: UNCOVERED_CONCRETE_QUESTION_REPLY,
          resolution,
          isFallback: true,
        }
      : undefined;
  }

  return {
    intent: resolution.intent,
    reply: resolution.reply,
    resolution,
    isFallback: false,
  };
}

export function buildFaqReply(intent: FaqIntentId, message = intent): string {
  const resolution = resolveFaqQuery(message);
  if (resolution.intent === intent) {
    return resolution.reply;
  }

  const entry = getFaqEntry(intent);
  return entry?.answer ?? UNCOVERED_CONCRETE_QUESTION_REPLY;
}
