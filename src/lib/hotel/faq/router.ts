import { HOTEL_DEMO_CONFIG } from "../config";
import { classifyFaqIntent } from "./classifier";
import { getFaqEntry } from "./catalog";
import type {
  FaqAction,
  FaqActionPreset,
  FaqIntentId,
  FaqResolution,
  FaqRuntimeLinks,
} from "./types";

const DEFAULT_RUNTIME_LINKS: FaqRuntimeLinks = {
  bookingFormUrl: HOTEL_DEMO_CONFIG.bookingFormUrl,
  lodgingInfoUrl: HOTEL_DEMO_CONFIG.bookingFormUrl,
  reservationsDemoUrl: "/reservas-demo",
  whatsappUrl: HOTEL_DEMO_CONFIG.whatsappUrl,
  contactPageUrl: "https://somosmuyperros.com/contacto/",
  contactEmail: "info@somosmuyperros.com",
  contactPhone: HOTEL_DEMO_CONFIG.whatsappPhone,
};

function formatHotelPriceReply() {
  return "Las tarifas 2026 son: 1 perro 30 €/noche, 2 perros 45 €/noche, 3 perros 50 €/noche y 4 perros 55 €/noche. Si me indicas fechas y mascotas, puedo calcular el precio de la estancia.";
}

function buildActionFromPreset(
  preset: FaqActionPreset,
  runtime: FaqRuntimeLinks,
): FaqAction | null {
  if (preset === "lodging_info" && runtime.lodgingInfoUrl) {
    return {
      label: "Cómo funciona el alojamiento",
      url: runtime.lodgingInfoUrl,
    };
  }

  if (preset === "booking_form") {
    return {
      label: "Ir al formulario de reserva",
      url: runtime.bookingFormUrl,
    };
  }

  if (preset === "reservations_demo" && runtime.reservationsDemoUrl) {
    return {
      label: "Ver reservas demo",
      url: runtime.reservationsDemoUrl,
    };
  }

  if (preset === "whatsapp_contact" && runtime.whatsappUrl) {
    return {
      label: "Abrir WhatsApp",
      url: runtime.whatsappUrl,
    };
  }

  if (preset === "contact_page" && runtime.contactPageUrl) {
    return {
      label: "Ver contacto",
      url: runtime.contactPageUrl,
    };
  }

  return null;
}

function buildActions(intent: FaqIntentId, runtime: FaqRuntimeLinks) {
  const entry = getFaqEntry(intent);
  if (!entry?.actionPresets) {
    return [];
  }

  return entry.actionPresets
    .map((preset) => buildActionFromPreset(preset, runtime))
    .filter((action): action is FaqAction => action !== null);
}

function buildReply(intent: FaqIntentId) {
  const entry = getFaqEntry(intent);
  if (!entry) {
    return "No estoy seguro de haberlo entendido del todo. ¿Quieres información general, consultar disponibilidad o hablar con una persona del equipo?";
  }

  if (intent === "faq_precio_hotel") {
    return formatHotelPriceReply();
  }

  if (intent === "workflow_disponibilidad") {
    return "Para comprobar disponibilidad real usamos el calendario de reservas con fechas y turnos. En producción entra por el formulario del hotel canino; cuando se revisa, confirmamos disponibilidad y coste por el canal adecuado.";
  }

  if (intent === "workflow_reserva") {
    return "Si ya quieres tramitar una reserva, pásala por el formulario. Así revisamos disponibilidad, calculamos el precio correcto y te confirmamos por WhatsApp.";
  }

  if (intent === "handoff_humano") {
    return "Para este caso prefiero que lo revise una persona del equipo, así te damos una respuesta segura. Escríbenos o llámanos y lo vemos contigo.";
  }

  return entry.answer;
}

export function resolveFaqQuery(
  text: string,
  runtimeOverrides: Partial<FaqRuntimeLinks> = {},
): FaqResolution {
  const runtime: FaqRuntimeLinks = {
    ...DEFAULT_RUNTIME_LINKS,
    ...runtimeOverrides,
  };
  const classification = classifyFaqIntent(text);
  const entry = getFaqEntry(classification.intent);

  if (!entry) {
    throw new Error(`No existe una entrada FAQ para el intent ${classification.intent}`);
  }

  return {
    intent: classification.intent,
    category: classification.category,
    outputType: classification.outputType,
    label: entry.label,
    reply: buildReply(classification.intent),
    actions: buildActions(classification.intent, runtime),
    score: classification.score,
    matchedSignals: classification.matchedSignals,
    usedFallback: classification.usedFallback,
  };
}
