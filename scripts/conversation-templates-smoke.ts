import {
  renderBathOfferTemplate,
  renderPositiveReviewRequestTemplate,
  renderPostStayFollowupTemplate,
  renderPrearrivalReminderTemplate,
  renderReservationConfirmationTemplate,
  renderReservationDeniedTemplate,
  renderReservationWelcomeIntroTemplate,
} from "@/lib/hotel/conversations/client-templates";
import { buildStatelessTemplatePreviewResult } from "@/lib/hotel/conversations/template-preview";

function assertIncludes(label: string, value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} missing expected snippet: ${expected}`);
  }
}

const confirmation = renderReservationConfirmationTemplate({
  clientName: "Pau",
  petNames: ["Kira"],
  checkIn: "2026-12-25",
  checkOut: "2026-12-26",
  checkInTime: "10:00",
  checkOutTime: "10:00",
  price: 60,
});
const welcome = renderReservationWelcomeIntroTemplate({
  clientName: "Pau",
  petNames: ["Kira"],
});
const denial = renderReservationDeniedTemplate({
  clientName: "Pau",
  petNames: ["Kira"],
  waitlistSupported: false,
});
const bath = renderBathOfferTemplate({ petNames: ["Kira"] });
const reminder = renderPrearrivalReminderTemplate({
  clientName: "Pau",
  petNames: ["Kira"],
  entryText: "25 de diciembre a las 10:00",
});
const postStay = renderPostStayFollowupTemplate({
  clientName: "Pau",
  petNames: ["Kira"],
});
const review = renderPositiveReviewRequestTemplate();

assertIncludes("reservation_confirmation", confirmation, "¡Tu reserva ha sido confirmada! ✅");
assertIncludes("reservation_confirmation", confirmation, "El coste de la estancia es de");
assertIncludes("reservation_confirmation", confirmation, "Horario de recepción: *8:00–11:00 | 16:30–19:30*");
assertIncludes("reservation_confirmation", confirmation, "📞 Avísanos cuando vengas de camino: 682 621 177");
assertIncludes("reservation_confirmation", confirmation, "https://goo.gl/maps/4M6YHVRhJTFeHPjq9");
assertIncludes("reservation_preconfirmation_welcome", welcome, "Soy Maria Jose, del Hotel Canino SomosMuyPerros");
assertIncludes("reservation_denial", denial, "Soy Rocío del Hotel Canino SomosMuyPerros");
assertIncludes("bath_offer", bath, "¿Quieres que bañemos a Kira antes de la salida?");
assertIncludes("reservation_reminder", reminder, "Le recordamos que tiene una reserva");
assertIncludes("post_stay_new_client_checkin", postStay, "después de su estancia con nosotros");
assertIncludes("positive_review_request", review, "https://g.page/r/CbNKrJ36PLSeEBE/review");

for (const [command, expected] of [
  ["plantilla confirmación", "Vista previa de plantilla: confirmación"],
  ["plantilla baño", "Vista previa de plantilla: baño"],
  ["plantilla recordatorio", "Vista previa de plantilla: recordatorio"],
] as const) {
  const result = buildStatelessTemplatePreviewResult(command, { NODE_ENV: "test" } as NodeJS.ProcessEnv);
  if (!result?.reply.includes(expected)) {
    throw new Error(`preview command failed: ${command}`);
  }
  if (result.reply.includes("ATENCIÓN LEER HASTA EL FINAL")) {
    throw new Error(`preview command rendered legacy placeholder: ${command}`);
  }
}

console.log("smoke:templates ok");
