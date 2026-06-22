import type { PendingReservationProposal } from "./types";

export const DEFAULT_CONTRACT_URL =
  "https://somosmuyperros.com/contrato-de-admision-e-ingreso/";
export const CONTRACT_TERMS_VERSION = "admision-ingreso-2026-06-22";

export interface ClientRequestsConfig {
  contractUrl: string;
  requireContractAcceptance: boolean;
  confirmationTemplateEnabled: boolean;
  reservationRemindersEnabled: boolean;
  postStayFollowupsEnabled: boolean;
  reminderDryRun: boolean;
  followupDryRun: boolean;
  welcomeDogPersonaEnabled: boolean;
  welcomeStickerDryRun: boolean;
  welcomeStickerMediaUrl?: string;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readStringEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export function getClientRequestsConfig(): ClientRequestsConfig {
  return {
    contractUrl: readStringEnv("HOTEL_CONTRACT_URL", DEFAULT_CONTRACT_URL),
    requireContractAcceptance: readBooleanEnv(
      "HOTEL_CONTRACT_ACCEPTANCE_REQUIRED",
      false,
    ),
    confirmationTemplateEnabled: readBooleanEnv(
      "HOTEL_CONFIRMATION_TEMPLATE_ENABLED",
      false,
    ),
    reservationRemindersEnabled: readBooleanEnv(
      "HOTEL_RESERVATION_REMINDERS_ENABLED",
      false,
    ),
    postStayFollowupsEnabled: readBooleanEnv("HOTEL_POST_STAY_FOLLOWUPS_ENABLED", false),
    reminderDryRun: readBooleanEnv("HOTEL_RESERVATION_REMINDERS_DRY_RUN", true),
    followupDryRun: readBooleanEnv("HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN", true),
    welcomeDogPersonaEnabled: readBooleanEnv("HOTEL_WELCOME_DOG_PERSONA_ENABLED", false),
    welcomeStickerDryRun: readBooleanEnv("HOTEL_WELCOME_STICKER_DRY_RUN", true),
    welcomeStickerMediaUrl: process.env.HOTEL_WELCOME_STICKER_MEDIA_URL?.trim() || undefined,
  };
}

function normalizeMessage(message: string): string {
  return message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isExplicitContractAcceptance(message: string): boolean {
  const normalized = normalizeMessage(message);
  return (
    normalized === "acepto" ||
    normalized === "si acepto" ||
    normalized === "he leido y acepto" ||
    normalized === "leido y acepto" ||
    normalized === "confirmo que acepto" ||
    normalized === "confirmo que lo he leido y acepto" ||
    normalized === "acepto las condiciones" ||
    normalized === "he leido y acepto las condiciones"
  );
}

export function isExplicitContractRejection(message: string): boolean {
  const normalized = normalizeMessage(message);
  return (
    normalized === "no acepto" ||
    normalized === "no lo acepto" ||
    normalized === "no acepto las condiciones"
  );
}

export function buildContractAcceptanceRequest(config = getClientRequestsConfig()): string {
  return [
    "Antes de confirmar la reserva, necesitamos que leas y aceptes el contrato de admision e ingreso y las condiciones del hotel:",
    config.contractUrl,
    "",
    "Cuando lo hayas leido, responde: acepto",
  ].join("\n");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatSlot(slot: PendingReservationProposal["checkInSlot"]): string {
  return slot === "morning" ? "manana" : "tarde";
}

export function buildReservationConfirmationTemplate(
  proposal: PendingReservationProposal,
): string {
  const petNames = proposal.petNames?.length
    ? proposal.petNames.join(", ")
    : proposal.petName;
  const owner = proposal.ownerName ?? proposal.clientName;

  return [
    "Reserva confirmada.",
    "",
    owner ? `Cliente: ${owner}` : undefined,
    `Mascota/s: ${petNames}`,
    `Entrada: ${formatDate(proposal.checkIn)} (${formatSlot(proposal.checkInSlot)})`,
    `Salida: ${formatDate(proposal.checkOut)} (${formatSlot(proposal.checkOutSlot)})`,
    proposal.price !== undefined ? `Precio: ${proposal.price} EUR` : undefined,
    "",
    "Gracias por confiar en Somos Muy Perros.",
    "Si necesitas cambiar cualquier detalle, escribenos por aqui y el equipo lo revisara.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
