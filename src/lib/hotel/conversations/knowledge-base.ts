import type { FaqIntentId } from "@/lib/hotel/faq";
import { buildFaqReply, matchFaqIntent } from "@/lib/hotel/knowledge/faq";

export type ConversationKnowledgeTopic =
  | "general_hotel_info"
  | "hotel_vs_daycare"
  | "reception_hours"
  | "stay_includes"
  | "food"
  | "medication"
  | "requirements"
  | "contract"
  | "bath_service"
  | "prices"
  | "location"
  | "booking"
  | "availability"
  | "puppy_age";

export interface ConversationKnowledgeEntry {
  id: ConversationKnowledgeTopic;
  topic: string;
  aliases: string[];
  semanticHints: string[];
  answerRenderKey?: string;
  answer?: string;
  faqIntent?: FaqIntentId;
  requiresHuman: boolean;
  requiresTool: boolean;
  confidenceRules: string[];
  relatedTopics: ConversationKnowledgeTopic[];
  lastReviewed: string;
  source: string;
  gap?: string;
}

export interface ConversationKnowledgeMatch {
  entry: ConversationKnowledgeEntry;
  confidence: number;
  matchedSignals: string[];
  answer?: string;
}

export interface RelativeDateRangeMatch {
  id:
    | "este_fin_de_semana"
    | "proximo_fin_de_semana"
    | "manana"
    | "pasado_manana"
    | "agosto"
    | "vacaciones"
    | "unos_dias"
    | "viernes_a_domingo"
    | "sabado_domingo";
  label: string;
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

export const HOTEL_CONVERSATION_KNOWLEDGE_BASE: readonly ConversationKnowledgeEntry[] = [
  {
    id: "general_hotel_info",
    topic: "Información general del hotel",
    aliases: ["informacion", "saber mas", "como funciona", "hotel canino", "residencia"],
    semanticHints: ["preguntas abiertas de preventa sobre el hotel"],
    answerRenderKey: "general_hotel_info",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["open_query_about_hotel", "quality_gate_skips_fast_path"],
    relatedTopics: ["reception_hours", "prices", "requirements", "booking", "bath_service", "location"],
    lastReviewed: "2026-07-02",
    source: "FAQ catalog and client templates in repo",
  },
  {
    id: "hotel_vs_daycare",
    topic: "Diferencia entre hotel y guardería",
    aliases: ["hotel y guarderia", "guarderia", "guardería", "diferencia"],
    semanticHints: ["comparación hotel canino y guardería de día"],
    faqIntent: "faq_peluqueria",
    answer:
      "El hotel es para estancias con noche y la guardería es para estancias de día. Si me dices qué necesitas y las fechas, te orientamos con el flujo adecuado.",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["direct_topic_alias"],
    relatedTopics: ["booking", "prices"],
    lastReviewed: "2026-07-02",
    source: "FAQ catalog categories and public site copy in repo",
  },
  {
    id: "reception_hours",
    topic: "Horarios de recepción",
    aliases: ["horario", "horarios", "recepcion", "recepción", "entrada", "salida", "recoger", "dejar"],
    semanticHints: ["horarios de entrada y salida"],
    faqIntent: "faq_horario",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match"],
    relatedTopics: ["booking", "availability"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "stay_includes",
    topic: "Qué incluye la estancia",
    aliases: ["incluye", "que incluye", "funcionamiento", "durante la estancia"],
    semanticHints: ["preguntas amplias sobre alojamiento"],
    answer:
      "Podemos explicarte horarios, requisitos, alimentación, seguimiento, servicios complementarios y cómo reservar. Para detalles concretos de una estancia, dime qué te preocupa y lo revisamos sin inventar información.",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["general_topic_match"],
    relatedTopics: ["food", "requirements", "bath_service", "booking"],
    lastReviewed: "2026-07-02",
    source: "FAQ catalog",
    gap: "No hay una descripción cerrada de todo lo incluido más allá de las FAQs existentes.",
  },
  {
    id: "food",
    topic: "Alimentación",
    aliases: ["comida", "pienso", "alimentacion", "alimentación", "barf"],
    semanticHints: ["comida propia o alimentación especial"],
    faqIntent: "faq_comida",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match"],
    relatedTopics: ["requirements", "booking"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "medication",
    topic: "Medicación y observaciones",
    aliases: ["medicacion", "medicación", "pastillas", "tratamiento", "observaciones"],
    semanticHints: ["medicación simple u observaciones de la mascota"],
    faqIntent: "faq_medicacion",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match", "complex_cases_handoff_in_faq_classifier"],
    relatedTopics: ["requirements", "booking"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "requirements",
    topic: "Vacunas, cartilla y microchip",
    aliases: ["vacunas", "cartilla", "microchip", "rabia", "tos de las perreras", "requisitos"],
    semanticHints: ["requisitos sanitarios"],
    faqIntent: "faq_vacunas",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match"],
    relatedTopics: ["food", "booking"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "contract",
    topic: "Contrato y condiciones",
    aliases: ["contrato", "condiciones", "admision", "admisión", "aceptar"],
    semanticHints: ["contrato de admisión e ingreso"],
    answer:
      "Cuando una reserva lo requiere, enviamos el enlace al contrato de admisión y pedimos aceptación explícita antes de confirmar. No sustituyo ese paso por una respuesta genérica.",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["contract_topic_match"],
    relatedTopics: ["booking"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/conversations/client-requests.ts",
  },
  {
    id: "bath_service",
    topic: "Baños y peluquería",
    aliases: ["baño", "bano", "peluqueria", "peluquería", "corte", "nudos", "pelo largo"],
    semanticHints: ["servicio de baño o peluquería"],
    faqIntent: "faq_peluqueria",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match", "client_template_bath_offer"],
    relatedTopics: ["prices", "booking"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/conversations/client-templates.ts",
  },
  {
    id: "prices",
    topic: "Precios",
    aliases: ["precio", "precios", "tarifa", "cuanto cuesta", "cuánto cuesta", "coste"],
    semanticHints: ["tarifas hotel, guardería o baño"],
    faqIntent: "faq_precio_hotel",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match"],
    relatedTopics: ["booking", "bath_service"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "location",
    topic: "Ubicación",
    aliases: ["ubicacion", "ubicación", "donde estais", "dónde estáis", "direccion", "dirección", "como llegar"],
    semanticHints: ["dirección y cómo llegar"],
    faqIntent: "faq_ubicacion",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["faq_direct_match"],
    relatedTopics: ["booking", "reception_hours"],
    lastReviewed: "2026-07-02",
    source: "src/lib/hotel/faq/catalog.ts",
  },
  {
    id: "booking",
    topic: "Cómo reservar",
    aliases: ["reservar", "reserva", "hacer reserva", "como reservo", "cómo reservo"],
    semanticHints: ["cómo iniciar o continuar una reserva"],
    faqIntent: "faq_reserva_formulario",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["reservation_intent_routes_to_stateful_flow_when formal"],
    relatedTopics: ["availability", "prices", "requirements"],
    lastReviewed: "2026-07-02",
    source: "FAQ catalog and reservation flow",
  },
  {
    id: "availability",
    topic: "Disponibilidad",
    aliases: ["disponibilidad", "hay sitio", "hay hueco", "hay plaza", "tenéis sitio", "teneis sitio"],
    semanticHints: ["consulta informal de disponibilidad"],
    answerRenderKey: "availability_informal_collect_details",
    requiresHuman: false,
    requiresTool: false,
    confidenceRules: ["never_claim_availability_without_tool", "collect_minimum_details_first"],
    relatedTopics: ["booking", "reception_hours"],
    lastReviewed: "2026-07-02",
    source: "reservation bridge has operational availability check after required details",
  },
  {
    id: "puppy_age",
    topic: "Cachorros y edad mínima",
    aliases: ["cachorro", "cachorros", "edad minima", "edad mínima"],
    semanticHints: ["edad mínima para alojar cachorros"],
    answer:
      "No tengo una regla de edad mínima cerrada en la base del repo. Si me dices la edad y vacunas del cachorro, lo dejamos para que el equipo lo revise.",
    requiresHuman: true,
    requiresTool: false,
    confidenceRules: ["known_gap_requires_human_review"],
    relatedTopics: ["requirements"],
    lastReviewed: "2026-07-02",
    source: "gap documented in this branch",
    gap: "Falta política oficial de edad mínima para cachorros.",
  },
] as const;

const FAQ_TOPIC_MAP: Partial<Record<FaqIntentId, ConversationKnowledgeTopic>> = {
  faq_horario: "reception_hours",
  faq_fuera_de_horario: "reception_hours",
  faq_precio_hotel: "prices",
  faq_precio_guarderia: "prices",
  faq_bono_guarderia: "prices",
  faq_vacunas: "requirements",
  faq_que_llevar: "requirements",
  faq_comida: "food",
  faq_medicacion: "medication",
  faq_pago_senal: "prices",
  faq_ubicacion: "location",
  faq_peluqueria: "bath_service",
  faq_reserva_formulario: "booking",
  workflow_disponibilidad: "availability",
  workflow_reserva: "booking",
};

function entryById(id: ConversationKnowledgeTopic): ConversationKnowledgeEntry {
  const entry = HOTEL_CONVERSATION_KNOWLEDGE_BASE.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Knowledge Base topic not found: ${id}`);
  }
  return entry;
}

export function extractRelativeDateRange(message: string): RelativeDateRangeMatch | undefined {
  const normalized = normalizeKnowledgeText(message);
  if (/\b(?:proximo\s+finde|proximo\s+fin\s+de\s+semana|el\s+proximo\s+finde)\b/.test(normalized)) {
    return { id: "proximo_fin_de_semana", label: "próximo fin de semana" };
  }
  if (/\b(?:este\s+finde|este\s+fin\s+de\s+semana|finde)\b/.test(normalized)) {
    return { id: "este_fin_de_semana", label: "este fin de semana" };
  }
  if (/\bmanana\b/.test(normalized)) {
    return { id: "manana", label: "mañana" };
  }
  if (/\bpasado\s+manana\b/.test(normalized)) {
    return { id: "pasado_manana", label: "pasado mañana" };
  }
  if (/\ben\s+agosto\b|\bagosto\b/.test(normalized)) {
    return { id: "agosto", label: "agosto" };
  }
  if (/\b(?:estas\s+vacaciones|vacaciones)\b/.test(normalized)) {
    return { id: "vacaciones", label: "estas vacaciones" };
  }
  if (/\bunos\s+dias\b/.test(normalized)) {
    return { id: "unos_dias", label: "unos días" };
  }
  if (/\bviernes\s+a\s+domingo\b/.test(normalized)) {
    return { id: "viernes_a_domingo", label: "viernes a domingo" };
  }
  if (/\bsabado\s+y\s+domingo\b|\bsabado\s+domingo\b/.test(normalized)) {
    return { id: "sabado_domingo", label: "sábado y domingo" };
  }
  return undefined;
}

export function buildKnowledgeBaseAnswer(entry: ConversationKnowledgeEntry): string {
  if (entry.answer) {
    return entry.answer;
  }
  if (entry.faqIntent) {
    return buildFaqReply(entry.faqIntent);
  }
  if (entry.answerRenderKey === "general_hotel_info") {
    return "Te puedo ayudar con servicios, horarios, precios publicados, requisitos, ubicación, baños y cómo reservar.";
  }
  return "Dime qué necesitas saber y te respondo con la información que tenemos confirmada.";
}

export function matchConversationKnowledgeBase(message: string): ConversationKnowledgeMatch | undefined {
  const normalized = normalizeKnowledgeText(message);
  if (!normalized) {
    return undefined;
  }

  const faqMatch = matchFaqIntent(message);
  if (faqMatch && !faqMatch.isFallback) {
    const topic = FAQ_TOPIC_MAP[faqMatch.intent];
    if (topic) {
      const entry = entryById(topic);
      return {
        entry,
        confidence: faqMatch.resolution.score >= 80 ? 0.95 : 0.8,
        matchedSignals: ["shared_faq_match", faqMatch.intent, ...faqMatch.resolution.matchedSignals],
        answer: faqMatch.reply,
      };
    }
  }

  if (/\b(?:me\s+gustaria\s+saber\s+mas|quiero\s+informacion|saber\s+mas\s+sobre\s+el\s+hotel|como\s+funciona)\b/.test(normalized)) {
    const entry = entryById("general_hotel_info");
    return {
      entry,
      confidence: 0.82,
      matchedSignals: ["open_general_hotel_info"],
      answer: buildKnowledgeBaseAnswer(entry),
    };
  }

  if (/\b(?:disponibilidad|hay\s+sitio|hay\s+hueco|hay\s+plaza|teneis\s+sitio|tenéis\s+sitio)\b/.test(normalized)) {
    const entry = entryById("availability");
    return {
      entry,
      confidence: extractRelativeDateRange(message) ? 0.9 : 0.76,
      matchedSignals: ["availability_query", extractRelativeDateRange(message)?.id].filter(Boolean) as string[],
      answer: buildKnowledgeBaseAnswer(entry),
    };
  }

  const scored = HOTEL_CONVERSATION_KNOWLEDGE_BASE.map((entry) => {
    const aliases = [...entry.aliases, ...entry.semanticHints].map((alias) => normalizeKnowledgeText(alias));
    const hits = aliases.filter((alias) => alias && normalized.includes(alias));
    return {
      entry,
      hits,
      score: hits.length * 20,
    };
  }).sort((left, right) => right.score - left.score);

  const top = scored[0];
  if (!top || top.score < 20) {
    return undefined;
  }

  return {
    entry: top.entry,
    confidence: Math.min(0.9, 0.55 + top.hits.length * 0.15),
    matchedSignals: ["kb_alias_match", ...top.hits],
    answer: buildKnowledgeBaseAnswer(top.entry),
  };
}

export function listKnowledgeBaseGaps(): ConversationKnowledgeEntry[] {
  return HOTEL_CONVERSATION_KNOWLEDGE_BASE.filter((entry) => Boolean(entry.gap));
}
