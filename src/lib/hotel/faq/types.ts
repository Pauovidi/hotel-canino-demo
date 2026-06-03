export type FaqCategoryId =
  | "reservas_confirmacion"
  | "horarios_entregas"
  | "precios_hotel"
  | "precios_guarderia"
  | "requisitos_sanitarios"
  | "confianza_seguridad_residencia"
  | "medicacion_comportamiento"
  | "comida_fotos_servicios"
  | "peluqueria"
  | "pagos_senal"
  | "cancelaciones"
  | "ubicacion_contacto"
  | "visitas_recogidas"
  | "bienestar_estancia"
  | "especiales_humano";

export type FaqIntentId =
  | "faq_reserva_formulario"
  | "faq_confirmacion_whatsapp"
  | "faq_horario"
  | "faq_fuera_de_horario"
  | "faq_precio_hotel"
  | "faq_precio_guarderia"
  | "faq_bono_guarderia"
  | "faq_vacunas"
  | "faq_confianza_residencia"
  | "faq_medicacion"
  | "faq_comportamiento"
  | "faq_comida"
  | "faq_fotos"
  | "faq_peluqueria"
  | "faq_veterinario"
  | "faq_pago_senal"
  | "faq_cancelacion"
  | "faq_ubicacion"
  | "faq_contacto"
  | "faq_visitas_hotel"
  | "faq_que_llevar"
  | "faq_recogida_familiar"
  | "faq_recomendacion_otro_sitio"
  | "faq_climatizacion"
  | "faq_tiempo_aire_libre"
  | "faq_seguimiento_estancia"
  | "workflow_disponibilidad"
  | "workflow_reserva"
  | "handoff_humano";

export type FaqOutputType = "faq" | "workflow" | "handoff";

export type FaqActionPreset =
  | "lodging_info"
  | "booking_form"
  | "reservations_demo"
  | "whatsapp_contact"
  | "contact_page";

export interface FaqAction {
  label: string;
  url: string;
}

export interface FaqRuntimeLinks {
  bookingFormUrl: string;
  lodgingInfoUrl?: string;
  reservationsDemoUrl?: string;
  whatsappUrl?: string;
  contactPageUrl?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface FaqCategoryDefinition {
  id: FaqCategoryId;
  title: string;
  summary: string;
  intents: readonly FaqKnowledgeEntry[];
}

export interface FaqKnowledgeEntry {
  intent: FaqIntentId;
  category: FaqCategoryId;
  outputType: FaqOutputType;
  label: string;
  question: string;
  answer: string;
  examples: string[];
  synonyms: string[];
  actionPresets?: FaqActionPreset[];
}

export interface FaqDemoPrompt {
  label: string;
  question: string;
  intent: FaqIntentId;
  outputType: FaqOutputType;
}

export interface FaqKnowledgePack {
  version: string;
  locale: "es-ES";
  assumptions: string[];
  fallbackAnswer: string;
  bookingFormUrl: string;
  categories: readonly FaqCategoryDefinition[];
  entries: readonly FaqKnowledgeEntry[];
  demoPrompts: readonly FaqDemoPrompt[];
}

export type FaqWidgetRoute = "faq" | "formulario" | "humano";

export interface FaqIntentMatch {
  id: FaqIntentId;
  categoryId: FaqCategoryId;
  question: string;
  answer: string;
  route: FaqWidgetRoute;
  cta?: {
    label: string;
    href: string;
  };
}

export interface FaqSignalSet {
  normalizedText: string;
  tokens: string[];
  hasDateSignal: boolean;
  hasTimeSignal: boolean;
  hasReserveVerb: boolean;
  hasHowToReserveSignal: boolean;
  hasAvailabilitySignal: boolean;
  hasWhatsappSignal: boolean;
  hasConfirmationSignal: boolean;
  hasReceptionScheduleSignal: boolean;
  hasOutsideHoursSignal: boolean;
  hasHotelPriceSignal: boolean;
  hasGuarderiaSignal: boolean;
  hasBonoSignal: boolean;
  hasVaccinesSignal: boolean;
  hasTrustResidenceSignal: boolean;
  hasMedicationSignal: boolean;
  hasBehaviorSignal: boolean;
  hasFoodSignal: boolean;
  hasPhotosSignal: boolean;
  hasPeluqueriaSignal: boolean;
  hasVeterinarySignal: boolean;
  hasPaymentSignal: boolean;
  hasCancellationSignal: boolean;
  hasLocationSignal: boolean;
  hasContactSignal: boolean;
  hasVisitSignal: boolean;
  hasWhatToBringSignal: boolean;
  hasFamilyPickupSignal: boolean;
  hasOtherSiteRecommendationSignal: boolean;
  hasTemperatureSignal: boolean;
  hasOutdoorTimeSignal: boolean;
  hasStayFollowupSignal: boolean;
  hasSpecialCaseSignal: boolean;
}

export interface FaqClassification {
  intent: FaqIntentId;
  category: FaqCategoryId;
  outputType: FaqOutputType;
  score: number;
  matchedSignals: string[];
  usedFallback: boolean;
  signals: FaqSignalSet;
}

export interface FaqResolution {
  intent: FaqIntentId;
  category: FaqCategoryId;
  outputType: FaqOutputType;
  label: string;
  reply: string;
  actions: FaqAction[];
  score: number;
  matchedSignals: string[];
  usedFallback: boolean;
}

export interface FaqRoutingRule {
  id: string;
  description: string;
  outputType: FaqOutputType;
  intents: readonly FaqIntentId[];
}
