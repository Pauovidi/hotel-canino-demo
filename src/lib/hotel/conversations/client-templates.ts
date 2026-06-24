import type { PendingReservationProposal } from "./types";

export interface ReservationTemplateInput {
  clientName?: string;
  petNames: string[];
  checkIn: string;
  checkOut: string;
  checkInTime?: string;
  checkOutTime?: string;
  price?: number;
  entryText?: string;
  exitText?: string;
  priceText?: string;
}

function fallbackName(value?: string): string {
  return value?.trim() || "familia";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatStayPoint(date: string, time?: string): string {
  return time ? `${formatDate(date)} a las ${time}` : formatDate(date);
}

function formatPetNames(petNames: string[]): string {
  return petNames.map((petName) => petName.trim()).filter(Boolean).join(", ");
}

function formatPrice(price: number): string {
  return `${Number.isInteger(price) ? price.toFixed(0) : price.toFixed(2).replace(".", ",")}€`;
}

export function reservationTemplateInputFromProposal(
  proposal: PendingReservationProposal,
): ReservationTemplateInput {
  return {
    clientName: proposal.ownerName ?? proposal.clientName,
    petNames: proposal.petNames?.length ? proposal.petNames : [proposal.petName],
    checkIn: proposal.checkIn,
    checkOut: proposal.checkOut,
    checkInTime: proposal.checkInTime,
    checkOutTime: proposal.checkOutTime,
    price: proposal.price,
  };
}

export function canRenderReservationConfirmationTemplate(
  input: Pick<ReservationTemplateInput, "price" | "priceText">,
): boolean {
  return Boolean(input.priceText?.trim()) || (typeof input.price === "number" && Number.isFinite(input.price));
}

export function renderReservationConfirmationTemplate(
  input: ReservationTemplateInput,
): string {
  if (!canRenderReservationConfirmationTemplate(input)) {
    throw new Error("reservation_confirmation_price_required");
  }

  return [
    `*Hola* ${fallbackName(input.clientName)}`,
    "¡Tu reserva ha sido confirmada! ✅",
    `Entrada: ${input.entryText?.trim() || formatStayPoint(input.checkIn, input.checkInTime)}`,
    `Salida: ${input.exitText?.trim() || formatStayPoint(input.checkOut, input.checkOutTime)}`,
    `Mascotas: ${formatPetNames(input.petNames)}`,
    "",
    `El coste de la estancia es de *${input.priceText?.trim() || formatPrice(input.price!)}*`,
    "",
    "🔴 Cualquier cambio en los horarios puede tener coste adicional.",
    "🔴 El pago se realiza a la llegada y en efectivo.",
    "🎒 Recuerda traer su cartilla, camita, comida y juguetes.",
    "🐕 Es obligatorio que tenga microchip y vacunas de rabia y polivalente",
    "(recomendamos también la tos de las perreras).",
    "🙏 Avísanos de cualquier detalle importante (medicación, comportamiento, celo, etc.).",
    "🕒 Horario de recepción: *8:00–11:00 | 16:30–19:30*",
    "📞 Avísanos cuando vengas de camino: 682 621 177",
    "📍 Ubicación:",
    "https://goo.gl/maps/4M6YHVRhJTFeHPjq9",
    "¡Gracias por confiar en nosotros! ❤️",
    "Hotel Canino Somosmuyperros 🐾🏡",
  ].join("\n");
}

export function renderBathOfferTemplate(): string {
  return [
    "¿Quiere que bañemos a su perro?",
    "El precio sería de 15€ para perros pequeños, 20€ para perros medianos y 25€ para perros grandes, siempre de pelo corto. Para pelo largo, nudos o corte de razas específicas, preguntar adjuntando una foto.",
  ].join("\n");
}

export function renderReservationWelcomeIntroTemplate(input: {
  clientName?: string;
  petNames: string[];
}): string {
  return [
    `Buenos días ${fallbackName(input.clientName)} 😊`,
    "Soy Maria Jose, del Hotel Canino SomosMuyPerros.",
    `A continuación te detallo la confirmación de la reserva de ${formatPetNames(input.petNames)}.`,
    "Si tienes cualquier duda o necesitas algo, no dudes en decírnoslo.",
    "¡Gracias por confiar en nosotros! 🐶💕",
  ].join("\n");
}

export function renderReservationDeniedTemplate(input: {
  clientName?: string;
  petNames: string[];
  waitlistSupported?: boolean;
}): string {
  const waitlistLine = input.waitlistSupported
    ? "Aun así, la hemos anotado en nuestra lista de espera y, si se produjera alguna baja, te contactaríamos de inmediato 🤞"
    : "Aun así, podemos dejarlo anotado para que el equipo lo revise si quieres que busquemos una alternativa 🤞";

  return [
    `Buenas tardes ${fallbackName(input.clientName)} 😊`,
    "Soy Rocío del Hotel Canino SomosMuyPerros.",
    `Lamentamos informarte de que en las fechas solicitadas no tenemos disponibilidad para alojar a ${formatPetNames(input.petNames)} con nosotros.`,
    waitlistLine,
    "Sentimos las molestias y te agradecemos mucho el interés y la confianza.",
    "Un cordial saludo 👋🐾",
  ].join("\n");
}

export function renderPrearrivalReminderTemplate(input: {
  clientName?: string;
  petNames: string[];
  entryText: string;
}): string {
  return [
    `Estimado/a ${fallbackName(input.clientName)}.`,
    "Le recordamos que tiene una reserva en nuestro Hotel Canino.",
    `Para sus mascotas: *${formatPetNames(input.petNames)}*`,
    `El día ${input.entryText}`,
    "Por favor, avísenos con anticipación si no puede asistir o necesita modificar la reserva y *cuál será su hora de llegada* ¡Gracias!",
    "Saludos,",
    "Somosmuyperros",
  ].join("\n");
}

export function renderPostStayFollowupTemplate(input: {
  clientName?: string;
  petNames: string[];
}): string {
  return `Buenos días ${fallbackName(input.clientName)}, qué tal ${formatPetNames(
    input.petNames,
  )} después de su estancia con nosotros ¿todo bien?`;
}

export function renderPositiveReviewRequestTemplate(): string {
  return [
    "Genial, pues nos alegramos un montón. 🤗",
    "Si os ha gustado la experiencia y nos quieres dejar una reseña positiva en nuestro perfil de Google te dejo por aquí el enlace directo, muchas gracias de antemano 🙏🏼😊",
    "En Somos Muy Perros queremos saber tu opinión. Publica una reseña en nuestro perfil. https://g.page/r/CbNKrJ36PLSeEBE/review",
  ].join("\n");
}
