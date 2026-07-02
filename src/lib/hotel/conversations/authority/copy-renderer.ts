import { matchFaqIntent } from "@/lib/hotel/knowledge/faq";
import {
  analyzeConversationIntelligence,
  buildNeedPetCountForQuoteReply,
  buildPriceQuoteReply,
  buildVagueDatePrecisionReply,
} from "../conversation-intelligence";
import {
  renderBathOfferTemplate,
  renderPositiveReviewRequestTemplate,
  renderPostStayFollowupTemplate,
  renderPrearrivalReminderTemplate,
  renderReservationConfirmationTemplate,
  renderReservationDeniedTemplate,
  renderReservationWelcomeIntroTemplate,
} from "../client-templates";
import { buildKnowledgeBaseAnswer, matchConversationKnowledgeBase } from "../knowledge-base";
import type { ConversationRecord, ConversationReservationFlow } from "../types";

export const CONVERSATION_RESET_REPLY = "Reiniciado.";

export type ConversationRenderKey =
  | "conversation.greeting"
  | "conversation.welcome_known_client"
  | "conversation.welcome_unknown_client"
  | "conversation.general_information"
  | "conversation.human_handoff"
  | "conversation.stay_status"
  | "conversation.unknown"
  | "conversation.reservation_start"
  | "conversation.availability_request"
  | "conversation.reservation_confirm"
  | "conversation.reservation_cancel"
  | "conversation.reservation_modify"
  | "conversation.reset"
  | "conversation.faq_reply"
  | "conversation.dynamic_reply"
  | "conversation.general_hotel_info"
  | "conversation.ask_info_topic"
  | "conversation.mixed_reservation_info_intro"
  | "conversation.availability_informal_collect_details"
  | "conversation.availability_needs_pet_and_dates"
  | "availability_first_collect_pet"
  | "availability_first_clarify_range"
  | "availability_first_checking"
  | "availability_first_available"
  | "availability_first_unavailable"
  | "availability_first_needs_details"
  | "availability_first_offer_reservation"
  | "availability_first_handoff_contextual"
  | "availability_first_pet_recorded_checking"
  | "availability_first_available_offer_reservation"
  | "availability_first_clarify_times"
  | "availability_first_clarify_pet_ambiguous"
  | "availability_first_precheck_error_handoff_contextual"
  | "conversation.kb_topic_answer"
  | "conversation.kb_topic_unknown_clarify"
  | "conversation.info_answer_then_resume_reservation"
  | "conversation.info_answer_then_offer_reservation"
  | "conversation.handoff_after_collected_availability_details"
  | "conversation.fallback_open_query_quality"
  | "reservation_confirmation"
  | "reservation_preconfirmation"
  | "reservation_denial"
  | "bath_offer"
  | "reservation_reminder"
  | "post_stay_new_client_checkin"
  | "positive_review_request"
  | "contract_link"
  | "contract_acceptance"
  | "reservation.ask_client_kind"
  | "reservation.ask_existing_email"
  | "reservation.ask_owner"
  | "reservation.ask_pet_names"
  | "reservation.pet_count_inconsistent"
  | "reservation.ask_pet_names_by_count"
  | "reservation.ask_exit_time"
  | "reservation.ask_entry_time"
  | "reservation.ask_exit_date_time"
  | "reservation.ask_entry_date_time"
  | "reservation.ask_entry_exit_times"
  | "reservation.ask_exit_and_times"
  | "reservation.ask_exit_and_times_from_entry"
  | "reservation.ask_entry_and_exit_dates"
  | "reservation.ask_entry_exit_date_time"
  | "reservation.ask_notes"
  | "reservation.ask_visit"
  | "reservation.keep_collecting"
  | "reservation.proposal"
  | "reservation.denied"
  | "reservation.known_client_intro"
  | "reservation.known_client_pet_prompt"
  | "reservation.known_client_email_prompt"
  | "reservation.known_client_pet_aware_prompt"
  | "reservation.client_record_found"
  | "reservation.time_preference_prompt"
  | "reservation.time_context_fallback"
  | "reservation.first_hour_preference"
  | "reservation.time_out_of_range"
  | "reservation.confirm_shared_out_of_range_time"
  | "reservation.confirm_shared_time"
  | "reservation.missing_month"
  | "reservation.email_review"
  | "reservation.known_email_collected"
  | "reservation.email_invalid"
  | "reservation.manual_review"
  | "reservation.existing_email_match"
  | "reservation.existing_email_not_found"
  | "reservation.pet_names_pending_review"
  | "reservation.too_many_pets_manual_review"
  | "reservation.out_of_range_rejected"
  | "reservation.visit_yes_prefix"
  | "reservation.visit_no_prefix"
  | "reservation.explicit_pet_correction_dates"
  | "reservation.cancelled"
  | "reservation.rejected_new_dates"
  | "reservation.resume_asking_client_kind"
  | "reservation.resume_asking_existing_email"
  | "reservation.resume_collecting_owner"
  | "reservation.resume_collecting_pet"
  | "reservation.resume_collecting_dates"
  | "reservation.resume_collecting_notes"
  | "reservation.resume_collecting_visit"
  | "reservation.resume_pending_availability"
  | "reservation.resume_pending_confirmation"
  | "service.store_degraded_critical"
  | "service.client_override_reservation"
  | "service.manual_review"
  | "service.bath_declined"
  | "service.bath_price_quoted"
  | "service.bath_size_requested"
  | "service.post_stay_negative_manual_review"
  | "service.loop_missing_exit_and_times"
  | "service.loop_have_hours_need_dates"
  | "service.loop_reformulation";

export interface RenderCopyInput {
  key: ConversationRenderKey;
  message?: string;
  reply?: string;
  name?: string;
  firstName?: string;
  pets?: string[];
  petName?: string;
  petCount?: number;
  nameCount?: number;
  statedCount?: number;
  date?: string;
  checkIn?: string;
  checkOut?: string;
  checkInTime?: string;
  checkOutTime?: string;
  entryText?: string;
  exitText?: string;
  priceText?: string;
  time?: string;
  times?: string[];
  price?: number;
  flow?: ConversationReservationFlow;
  conversation?: ConversationRecord;
  waitlistSupported?: boolean;
  topic?: string;
  topicAnswer?: string;
  relativeDateRange?: string;
  contractUrl?: string;
}

export interface ConversationRenderPlan {
  renderKey: ConversationRenderKey;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;:()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function greetingPrefix(message: string): string | undefined {
  const normalized = normalizeText(message);
  if (/\bbuenos dias\b/.test(normalized) || /\bbuen dia\b/.test(normalized)) {
    return "Buenos días.";
  }
  if (/\bbuenas tardes\b/.test(normalized)) {
    return "Buenas tardes.";
  }
  if (/\bbuenas noches\b/.test(normalized)) {
    return "Buenas noches.";
  }
  if (/\bbuenas\b/.test(normalized)) {
    return "Buenas.";
  }
  if (/\bhola+\b/.test(normalized) || /\bhey\b/.test(normalized)) {
    return "¡Hola!";
  }
  return undefined;
}

function withGreeting(message: string | undefined, reply: string): string {
  const prefix = message ? greetingPrefix(message) : undefined;
  return prefix ? `${prefix} ${reply}` : reply;
}

export function formatReservationDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatPetList(pets: string[]): string {
  if (pets.length <= 1) {
    return pets[0] ?? "";
  }

  return `${pets.slice(0, -1).join(", ")} y ${pets.at(-1)}`;
}

function namesQuestion(count: number): string {
  if (count === 1) {
    return "Gracias. ¿Cómo se llama la mascota?";
  }
  if (count === 2) {
    return "Gracias. ¿Cómo se llaman las dos mascotas?";
  }
  return `Gracias. ¿Cómo se llaman las ${count} mascotas?`;
}

function renderKnownClientIntro(input: RenderCopyInput): string {
  return input.firstName
    ? `Genial, ${input.firstName}. Te localizo en nuestra ficha.`
    : "Genial. Te localizo en nuestra ficha.";
}

function renderKnownClientPetAwarePrompt(input: RenderCopyInput): string {
  const pets = input.pets ?? [];
  const intro = input.firstName ? `Genial, ${input.firstName}.` : "Genial.";

  if (pets.length === 1) {
    return `${intro} Tengo registrada a ${pets[0]}. ¿Qué fechas necesitas para la reserva?`;
  }

  if (pets.length > 1) {
    return `${intro} Tengo registradas a ${formatPetList(pets)}. ¿La reserva sería para alguna de ellas o para otra mascota?`;
  }

  return renderCopy({
    ...input,
    key: "reservation.known_client_pet_prompt",
  });
}

function renderNextCollection(flow: ConversationReservationFlow): string {
  if (flow.status === "asking_client_kind") {
    return renderCopy({ key: "reservation.ask_client_kind" });
  }
  if (flow.status === "asking_existing_email") {
    return renderCopy({ key: "reservation.ask_existing_email" });
  }
  if (flow.status === "collecting_owner") {
    return renderCopy({ key: "reservation.ask_owner" });
  }
  if (flow.status === "collecting_pet") {
    if (flow.petCountInconsistency) {
      return renderCopy({
        key: "reservation.pet_count_inconsistent",
        nameCount: flow.petCountInconsistency.nameCount,
        statedCount: flow.petCountInconsistency.statedCount,
      });
    }
    if (flow.petCount && !flow.petName) {
      return renderCopy({ key: "reservation.ask_pet_names_by_count", petCount: flow.petCount });
    }
    return renderCopy({ key: "reservation.ask_pet_names" });
  }
  if (flow.status === "collecting_dates") {
    if (flow.checkInDate && flow.checkOutDate && flow.checkInTime && !flow.checkOutTime) {
      return renderCopy({ key: "reservation.ask_exit_time", date: flow.checkOutDate });
    }
    if (flow.checkInDate && flow.checkOutDate && flow.checkOutTime && !flow.checkInTime) {
      return renderCopy({ key: "reservation.ask_entry_time" });
    }
    if (flow.checkInDate && flow.checkInTime && (!flow.checkOutDate || !flow.checkOutTime)) {
      return renderCopy({ key: "reservation.ask_exit_date_time" });
    }
    if (flow.checkOutDate && flow.checkOutTime && (!flow.checkInDate || !flow.checkInTime)) {
      return renderCopy({ key: "reservation.ask_entry_date_time" });
    }
    if (flow.checkInDate && flow.checkOutDate && (!flow.checkInTime || !flow.checkOutTime)) {
      return renderCopy({ key: "reservation.ask_entry_exit_times" });
    }
    if (flow.checkInDate && !flow.checkOutDate && !flow.checkInTime && !flow.checkOutTime) {
      return renderCopy({ key: "reservation.ask_exit_and_times" });
    }
    if (flow.checkInDate && !flow.checkInTime && (!flow.checkOutDate || !flow.checkOutTime)) {
      return renderCopy({ key: "reservation.ask_exit_and_times_from_entry" });
    }
    if ((!flow.checkInDate || !flow.checkOutDate) && (flow.checkInTime || flow.checkOutTime)) {
      return renderCopy({ key: "reservation.ask_entry_and_exit_dates" });
    }
    return renderCopy({ key: "reservation.ask_entry_exit_date_time" });
  }
  if (flow.status === "collecting_notes") {
    return renderCopy({ key: "reservation.ask_notes" });
  }
  if (flow.status === "collecting_visit") {
    return renderCopy({ key: "reservation.ask_visit" });
  }
  return renderCopy({ key: "reservation.keep_collecting" });
}

export function renderReservationFlowCopy(input: RenderCopyInput): string {
  return renderCopy(input);
}

export function renderConversationReplyPlan(plan: ConversationRenderPlan, message: string): string {
  return renderCopy({ key: plan.renderKey, message });
}

export function renderCopy(input: RenderCopyInput): string {
  switch (input.key) {
    case "conversation.greeting":
      return `${greetingPrefix(input.message ?? "") ?? "¡Hola!"} ¿En qué podemos ayudarte?`;
    case "conversation.welcome_known_client":
      return withGreeting(
        input.message,
        `${input.firstName ? `${input.firstName}, ` : ""}bienvenido/a a Somos Muy Perros. Soy el asistente del Hotel Canino; puedo ayudarte con reservas, disponibilidad, precios, cambios o dudas del hotel.`,
      );
    case "conversation.welcome_unknown_client":
      return withGreeting(
        input.message,
        "bienvenido/a a Somos Muy Perros. Soy el asistente del Hotel Canino; puedo ayudarte con reservas, disponibilidad, precios, cambios o dudas del hotel.",
      );
    case "conversation.general_information":
      return withGreeting(
        input.message,
        "Claro. Te puedo ayudar con horarios, visitas, reservas, vacunas, alimentación, qué traer y funcionamiento del hotel. ¿Sobre qué necesitas información?",
      );
    case "conversation.general_hotel_info":
      return withGreeting(
        input.message,
        "Somos Muy Perros es hotel canino y guardería. Te puedo ayudar con servicios, horarios, precios publicados, requisitos, ubicación, baños/peluquería y cómo reservar. ¿Qué quieres saber primero?",
      );
    case "conversation.ask_info_topic":
      return withGreeting(
        input.message,
        "Claro, dime qué quieres saber y te respondo con la información que tenemos confirmada.",
      );
    case "conversation.mixed_reservation_info_intro":
      return withGreeting(
        input.message,
        "Claro, dime qué quieres saber y después seguimos con la reserva.",
      );
    case "conversation.availability_informal_collect_details": {
      const range = input.relativeDateRange ? ` para ${input.relativeDateRange}` : "";
      return withGreeting(
        input.message,
        `Puedo ayudarte a preparar la consulta de disponibilidad${range}. Para revisarlo con seguridad necesito el nombre de la mascota y las fechas aproximadas de entrada y salida. No te confirmo plaza hasta comprobarlo con el flujo operativo.`,
      );
    }
    case "conversation.availability_needs_pet_and_dates":
      return "Para revisar disponibilidad necesito el nombre de la mascota y las fechas aproximadas de entrada y salida.";
    case "availability_first_collect_pet": {
      const range = input.relativeDateRange ? ` para ${input.relativeDateRange}` : "";
      return withGreeting(
        input.message,
        `Puedo preparar la consulta de disponibilidad${range}. Me falta solo el nombre de la mascota. No te confirmo plaza hasta comprobarlo con el flujo operativo.`,
      );
    }
    case "availability_first_clarify_range":
      return withGreeting(
        input.message,
        "Puedo preparar la consulta de disponibilidad. Me falta la fecha o rango aproximado de entrada y salida. No te confirmo plaza hasta comprobarlo con el flujo operativo.",
      );
    case "availability_first_checking":
      return "Gracias. Con esos datos puedo revisar disponibilidad con el flujo operativo antes de seguir con la reserva.";
    case "availability_first_available":
      return "Hay disponibilidad según la comprobación operativa. Si quieres, seguimos con la reserva.";
    case "availability_first_unavailable":
      return "No aparece disponibilidad según la comprobación operativa. Si quieres, lo puede revisar el equipo.";
    case "availability_first_needs_details":
      return withGreeting(
        input.message,
        "Puedo preparar la consulta de disponibilidad. Me faltan el nombre de la mascota y el rango aproximado de entrada y salida. No te confirmo plaza hasta comprobarlo con el flujo operativo.",
      );
    case "availability_first_offer_reservation":
      return "Si quieres, con esos datos seguimos con la reserva.";
    case "availability_first_handoff_contextual":
      return "Gracias. Con esos datos lo puede revisar el equipo y contestarte con disponibilidad real por aquí.";
    case "availability_first_pet_recorded_checking":
      return `Perfecto${input.petName ? `, sería para ${input.petName}` : ""}. Compruebo disponibilidad con el flujo operativo antes de seguir con la reserva.`;
    case "availability_first_available_offer_reservation":
      return `Hay disponibilidad según la comprobación operativa${input.petName ? ` para ${input.petName}` : ""}. Si quieres, seguimos con la reserva.`;
    case "availability_first_clarify_times":
      return `Perfecto${input.petName ? `, sería para ${input.petName}` : ""}. Para comprobar disponibilidad me falta la hora aproximada de entrada y salida. No te confirmo plaza hasta comprobarlo con el flujo operativo.`;
    case "availability_first_clarify_pet_ambiguous":
      return input.pets?.length
        ? `Tengo registradas a ${formatPetList(input.pets)}. ¿Para cuál de ellas quieres consultar disponibilidad?`
        : "¿Me confirmas el nombre de la mascota para consultar disponibilidad?";
    case "availability_first_precheck_error_handoff_contextual":
      return "Con esos datos no he podido completar la comprobación automática. Lo puede revisar el equipo y contestarte con disponibilidad real por aquí.";
    case "conversation.kb_topic_answer": {
      if (input.topicAnswer) {
        return input.topicAnswer;
      }
      const match = input.message ? matchConversationKnowledgeBase(input.message) : undefined;
      return match
        ? buildKnowledgeBaseAnswer(match.entry)
        : renderCopy({ key: "conversation.kb_topic_unknown_clarify", message: input.message });
    }
    case "conversation.kb_topic_unknown_clarify":
      return "Puedo ayudarte con horarios, precios, requisitos, ubicación, baños, comida, visitas o cómo reservar. ¿Qué punto quieres ver?";
    case "conversation.info_answer_then_resume_reservation": {
      const answer =
        input.topicAnswer ??
        (input.message
          ? matchConversationKnowledgeBase(input.message)?.answer
          : undefined) ??
        renderCopy({ key: "conversation.kb_topic_unknown_clarify", message: input.message });
      return `${answer}\n\nCuando quieras, seguimos con la reserva.`;
    }
    case "conversation.info_answer_then_offer_reservation": {
      const answer = input.topicAnswer ?? renderCopy({ key: "conversation.general_hotel_info", message: input.message });
      return `${answer}\n\nSi quieres reservar, dime fechas y mascota y empezamos.`;
    }
    case "conversation.handoff_after_collected_availability_details":
      return "Gracias. Con esos datos lo puede revisar el equipo y contestarte con disponibilidad real por aquí.";
    case "conversation.fallback_open_query_quality":
      return "No quiero inventar esa información. Puedo ayudarte con horarios, precios publicados, requisitos, ubicación, servicios o cómo reservar. ¿Cuál de esos temas necesitas?";
    case "conversation.human_handoff":
      return "Perfecto, te paso con una persona del equipo. En cuanto puedan te responderán por aquí.";
    case "conversation.stay_status":
      return "Para darte una respuesta real sobre cómo está tu perro, lo revisa una persona del equipo y te contestamos por aquí.";
    case "conversation.unknown":
      return "Perdona, no te he entendido bien. ¿Quieres hacer una reserva, consultar disponibilidad o resolver alguna duda del hotel?";
    case "conversation.reservation_start":
      return withGreeting(
        input.message,
        "Te ayudo con la reserva. Dime, por favor, la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
      );
    case "conversation.availability_request":
      return withGreeting(
        input.message,
        "Para consultar disponibilidad, dime la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
      );
    case "conversation.reservation_confirm":
      return "Para confirmar una reserva necesitamos una propuesta válida revisada por el equipo. Si ya tienes una solicitud en marcha, te paso con una persona para confirmarla con seguridad.";
    case "conversation.reservation_cancel":
      return "Claro. Te ayudo a cancelarla. Primero necesito localizar la reserva.";
    case "conversation.reservation_modify":
      return "Claro. Te ayudo a modificarla. ¿Quieres cambiar fechas, datos de la mascota, observaciones o cancelar la reserva?";
    case "conversation.reset":
      return CONVERSATION_RESET_REPLY;
    case "conversation.faq_reply": {
      const faqMatch = input.message ? matchFaqIntent(input.message) : undefined;
      return faqMatch?.reply ?? input.reply ?? renderCopy({ key: "conversation.unknown", message: input.message });
    }
    case "conversation.dynamic_reply":
      if (input.message) {
        const intelligence = analyzeConversationIntelligence(input.message);
        if (intelligence.needsExactDate) {
          return buildVagueDatePrecisionReply(intelligence);
        }
        if (intelligence.checkInDate && intelligence.checkOutDate && intelligence.petCount) {
          return buildPriceQuoteReply({
            petCount: intelligence.petCount,
            checkInDate: intelligence.checkInDate,
            checkOutDate: intelligence.checkOutDate,
          });
        }
        return buildNeedPetCountForQuoteReply(intelligence);
      }
      return input.reply ?? "";
    case "reservation_confirmation":
      return renderReservationConfirmationTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
        checkIn: input.checkIn ?? input.date!,
        checkOut: input.checkOut ?? input.date!,
        checkInTime: input.checkInTime,
        checkOutTime: input.checkOutTime,
        price: input.price,
        entryText: input.entryText,
        exitText: input.exitText,
        priceText: input.priceText,
      });
    case "reservation_preconfirmation":
      return renderReservationWelcomeIntroTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
      });
    case "reservation_denial":
      return renderReservationDeniedTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
        waitlistSupported: Boolean(input.waitlistSupported),
      });
    case "bath_offer":
      return renderBathOfferTemplate({ petNames: input.pets?.length ? input.pets : input.petName ? [input.petName] : undefined });
    case "reservation_reminder":
      return renderPrearrivalReminderTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
        entryText: input.entryText ?? input.date ?? "la fecha prevista",
      });
    case "post_stay_new_client_checkin":
      return renderPostStayFollowupTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
      });
    case "positive_review_request":
      return renderPositiveReviewRequestTemplate();
    case "contract_link":
      return `Antes de confirmar, necesitamos que leas el contrato de admisión: ${input.contractUrl ?? "https://somosmuyperros.com/contrato-de-admision-e-ingreso/"}\n\n¿Confirmas que lo has leído y aceptas las condiciones?`;
    case "contract_acceptance":
      return "Gracias, dejamos registrada la aceptación del contrato para continuar con la reserva.";
    case "reservation.ask_client_kind":
      return "Genial. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.";
    case "reservation.ask_existing_email":
      return "Genial. Para localizar tu ficha, dime el email con el que sueles reservar.";
    case "reservation.ask_owner":
      return "De acuerdo, te tomo los datos para la reserva. Primero dime tu nombre y apellidos y tu email.";
    case "reservation.ask_pet_names":
      return "Genial. Dime el nombre o los nombres de tu mascota/s.";
    case "reservation.pet_count_inconsistent":
      return `Tengo ${input.nameCount} nombres pero indicas ${input.statedCount} perros. ¿Me confirmas los nombres de las ${input.statedCount} mascotas?`;
    case "reservation.ask_pet_names_by_count":
      return namesQuestion(input.petCount ?? 1);
    case "reservation.ask_exit_time":
      return `Tengo la salida para el ${formatReservationDate(input.date!)}. ¿A qué hora sería?`;
    case "reservation.ask_entry_time":
      return "Tengo la hora de salida. ¿A qué hora sería la entrada?";
    case "reservation.ask_exit_date_time":
      return "Perfecto, tengo la entrada. ¿Qué día y a qué hora sería la salida?";
    case "reservation.ask_entry_date_time":
      return "Tengo la salida. ¿Qué día y a qué hora sería la entrada?";
    case "reservation.ask_entry_exit_times":
      return "Ya tengo las fechas. Me falta la hora de entrada y la hora de salida. ¿Me las indicas?";
    case "reservation.ask_exit_and_times":
      return "Entiendo que la entrada sería ese día. Me falta la salida y las horas. ¿Me las indicas?";
    case "reservation.ask_exit_and_times_from_entry":
      return "Entiendo la fecha de entrada. Me falta la salida y las horas. ¿Me las indicas?";
    case "reservation.ask_entry_and_exit_dates":
      return "Gracias. ¿Qué fecha de entrada y qué fecha de salida serían?";
    case "reservation.ask_entry_exit_date_time":
      return "Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.";
    case "reservation.ask_notes":
      return "Anotado. ¿Hay alimentación, medicación o alguna observación importante?";
    case "reservation.ask_visit":
      return "¿Quieres visitar el hotel antes de confirmar?";
    case "reservation.keep_collecting":
      return "Vale. Sigo con la reserva.";
    case "reservation.proposal": {
      const flow = input.flow!;
      return `Tenemos disponibilidad para ${flow.petName} del ${formatReservationDate(flow.checkInDate!)} a las ${flow.checkInTime} al ${formatReservationDate(flow.checkOutDate!)} a las ${flow.checkOutTime}. El precio sería de ${flow.price} €. ¿Confirmas la reserva?`;
    }
    case "reservation.denied":
      return renderReservationDeniedTemplate({
        clientName: input.name,
        petNames: input.pets?.length ? input.pets : [input.petName ?? "tu mascota"],
        waitlistSupported: Boolean(input.waitlistSupported),
      });
    case "reservation.known_client_intro":
      return renderKnownClientIntro(input);
    case "reservation.known_client_pet_prompt":
      return `${renderKnownClientIntro(input)} Dime el nombre de tu mascota o mascotas y las fechas de la reserva.`;
    case "reservation.known_client_email_prompt":
      return `${renderKnownClientIntro(input)} Antes de seguir, ¿me confirmas el email que quieres asociar a esta reserva?`;
    case "reservation.known_client_pet_aware_prompt":
      return renderKnownClientPetAwarePrompt(input);
    case "reservation.client_record_found":
      return "He encontrado una ficha con este teléfono, así que seguimos con tu reserva.";
    case "reservation.time_preference_prompt":
      return "Sin problema. ¿Prefieres mañana o tarde? Si te da igual, puedo poner la primera hora de la mañana o la primera de la tarde.";
    case "reservation.time_context_fallback":
      return "Para poder calcular disponibilidad y precio necesito la hora de entrada y la hora de salida. Si te da igual, puedo proponerte primera hora de la mañana o primera hora de la tarde.";
    case "reservation.first_hour_preference":
      return "¿Primera hora de la mañana o primera hora de la tarde?";
    case "reservation.time_out_of_range": {
      const unique = Array.from(new Set(input.times ?? []));
      const understood = unique.length === 1 ? unique[0] : unique.join(" y ");
      return `He entendido ${understood}, pero puede quedar fuera del horario habitual. ¿Quieres que lo dejemos en primera hora de la mañana o primera hora de la tarde?`;
    }
    case "reservation.confirm_shared_out_of_range_time":
      return `He entendido ${input.time}, pero puede quedar fuera del horario habitual. ¿Confirmas que usemos las ${input.time} tanto para la entrada como para la salida?`;
    case "reservation.confirm_shared_time":
      return `¿Ponemos las ${input.time} tanto para la entrada como para la salida?`;
    case "reservation.missing_month":
      return "Entiendo los días, pero necesito el mes para revisar disponibilidad. ¿De qué mes sería?";
    case "reservation.email_review":
      return "Gracias. He encontrado una ficha con este teléfono; dejamos ese email marcado para revisión y seguimos con la reserva. Dime el nombre de tu mascota o mascotas.";
    case "reservation.known_email_collected":
      return input.petName
        ? `Gracias. Tengo registrada a ${input.petName}. ¿Qué fechas necesitas para la reserva?`
        : "Gracias. Dime el nombre de tu mascota o mascotas y las fechas de la reserva.";
    case "reservation.email_invalid":
      return "Necesito un email válido para localizar tu ficha de cliente.";
    case "reservation.manual_review":
      return "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.";
    case "reservation.existing_email_match":
      return input.petName
        ? `Genial. Tengo registrada a ${input.petName}. ¿Qué fechas necesitas para la reserva?`
        : "Genial. Dime el nombre o los nombres de tu mascota/s, y después vemos fechas y horarios.";
    case "reservation.existing_email_not_found":
      return "No encuentro ese email en la ficha de clientes. Puedo tomar tus datos como nuevo contacto para esta reserva. Dime tu nombre y apellidos.";
    case "reservation.pet_names_pending_review":
      return "Sin problema. Podemos dejarlo pendiente para revisión, pero necesitaremos los nombres antes de confirmar la reserva.";
    case "reservation.too_many_pets_manual_review":
      return "Para más de 4 perros necesitamos revisarlo con el equipo antes de darte precio.";
    case "reservation.out_of_range_rejected":
      return "De acuerdo. ¿Prefieres primera hora de la mañana o primera hora de la tarde?";
    case "reservation.visit_yes_prefix":
      return "Anotado. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00. Lo dejamos apuntado para el equipo. ";
    case "reservation.visit_no_prefix":
      return "De acuerdo, seguimos con la reserva. ";
    case "reservation.explicit_pet_correction_dates":
      return `Perfecto, sería para ${input.petName}. ¿Qué fechas necesitas para la reserva?`;
    case "reservation.cancelled":
      return "De acuerdo, dejamos la reserva sin continuar. Si necesitas otra cosa, estoy por aquí.";
    case "reservation.rejected_new_dates":
      return "De acuerdo, no confirmamos esa propuesta. Dime las nuevas fechas y horarios y lo reviso de nuevo.";
    case "reservation.resume_asking_client_kind":
      return "Seguimos con la reserva. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.";
    case "reservation.resume_asking_existing_email":
      return "Seguimos con la reserva. Me falta el email para localizar tu ficha de cliente.";
    case "reservation.resume_collecting_owner":
      return "Seguimos con la reserva. Me falta tu nombre y apellidos.";
    case "reservation.resume_collecting_pet":
      return "Seguimos con la reserva. Me falta el nombre o los nombres de tu mascota/s.";
    case "reservation.resume_collecting_dates":
      return "Seguimos con la reserva. Me faltan la fecha de entrada y la fecha de salida.";
    case "reservation.resume_collecting_notes":
      return "Seguimos con la reserva. Me falta saber si hay alimentación, medicación u observaciones importantes.";
    case "reservation.resume_collecting_visit":
      return "Seguimos con la reserva. ¿Quieres visitar el hotel antes de confirmar?";
    case "reservation.resume_pending_availability":
      return "Seguimos con la reserva. Estoy revisando disponibilidad para poder proponértela con seguridad.";
    case "reservation.resume_pending_confirmation":
      return "Seguimos con la reserva. Si quieres dejarla anotada, responde “sí, confirma”.";
    case "service.store_degraded_critical":
      return "Ahora mismo no puedo consultar correctamente la conversación. Te contestamos por aquí en cuanto lo revisemos.";
    case "service.client_override_reservation":
      return "He encontrado una ficha con este teléfono, así que seguimos con tu reserva. Si quieres reservar, dime el nombre de tu mascota o mascotas y las fechas.";
    case "service.manual_review":
      return "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.";
    case "service.bath_declined":
      return "De acuerdo, no añadimos baño.";
    case "service.bath_price_quoted":
      return `Perfecto. Para pelo corto, el baño serían ${input.price}€. Lo dejamos anotado para recepción.`;
    case "service.bath_size_requested":
      return "Perfecto. ¿Es pequeño, mediano o grande? Solo damos precio automático si es de pelo corto.";
    case "service.post_stay_negative_manual_review":
      return "Gracias por avisarnos. Lo revisa el equipo y te contestamos por aquí.";
    case "service.loop_missing_exit_and_times":
      return "Entiendo parte de la reserva. Me falta la salida y las horas. ¿Me las indicas?";
    case "service.loop_have_hours_need_dates":
      return "Perfecto, tengo las horas. ¿Qué fecha de entrada y qué fecha de salida serían?";
    case "service.loop_reformulation":
      return `Perdona, lo reformulo. ${input.reply ?? ""}`;
  }
}

export function renderNextReservationQuestion(flow: ConversationReservationFlow): string {
  return renderNextCollection(flow);
}
