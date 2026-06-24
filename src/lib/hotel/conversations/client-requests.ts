import {
  renderReservationConfirmationTemplate,
  reservationTemplateInputFromProposal,
} from "./client-templates";
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
  postStayFollowupOnlyNewClients: boolean;
  welcomeDogPersonaEnabled: boolean;
  welcomeStickerDryRun: boolean;
  welcomeStickerMediaUrl?: string;
  templatePreviewEnabled: boolean;
  templatePreviewAllowInSandbox: boolean;
  templatePreviewAdminOnly: boolean;
  templatePreviewSampleClientName: string;
  templatePreviewSamplePets: string[];
  templatePreviewSamplePrice: string;
  templatePreviewSampleEntry: string;
  templatePreviewSampleExit: string;
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

function readBooleanEnvAliases(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    if (process.env[name] !== undefined) {
      return readBooleanEnv(name, fallback);
    }
  }

  return fallback;
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
    reservationRemindersEnabled: readBooleanEnvAliases(
      ["HOTEL_RESERVATION_REMINDERS_ENABLED", "HOTEL_RESERVATION_REMINDER_ENABLED"],
      false,
    ),
    postStayFollowupsEnabled: readBooleanEnvAliases(
      ["HOTEL_POST_STAY_FOLLOWUPS_ENABLED", "HOTEL_POST_STAY_FOLLOWUP_ENABLED"],
      false,
    ),
    reminderDryRun: readBooleanEnvAliases(
      ["HOTEL_RESERVATION_REMINDERS_DRY_RUN", "HOTEL_RESERVATION_REMINDER_DRY_RUN"],
      true,
    ),
    followupDryRun: readBooleanEnvAliases(
      ["HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN", "HOTEL_POST_STAY_FOLLOWUP_DRY_RUN"],
      true,
    ),
    postStayFollowupOnlyNewClients: readBooleanEnv(
      "HOTEL_POST_STAY_FOLLOWUP_ONLY_NEW_CLIENTS",
      true,
    ),
    welcomeDogPersonaEnabled: readBooleanEnv("HOTEL_WELCOME_DOG_PERSONA_ENABLED", false),
    welcomeStickerDryRun: readBooleanEnv("HOTEL_WELCOME_STICKER_DRY_RUN", true),
    welcomeStickerMediaUrl: process.env.HOTEL_WELCOME_STICKER_MEDIA_URL?.trim() || undefined,
    templatePreviewEnabled: readBooleanEnv("HOTEL_TEMPLATE_PREVIEW_ENABLED", false),
    templatePreviewAllowInSandbox: readBooleanEnv(
      "HOTEL_TEMPLATE_PREVIEW_ALLOW_IN_SANDBOX",
      true,
    ),
    templatePreviewAdminOnly: readBooleanEnv("HOTEL_TEMPLATE_PREVIEW_ADMIN_ONLY", true),
    templatePreviewSampleClientName: readStringEnv(
      "HOTEL_TEMPLATE_PREVIEW_SAMPLE_CLIENT_NAME",
      "Pau",
    ),
    templatePreviewSamplePets: readStringEnv(
      "HOTEL_TEMPLATE_PREVIEW_SAMPLE_PETS",
      "PIPO",
    )
      .split(/\s*,\s*/)
      .map((pet) => pet.trim())
      .filter(Boolean),
    templatePreviewSamplePrice: readStringEnv(
      "HOTEL_TEMPLATE_PREVIEW_SAMPLE_PRICE",
      "30€",
    ),
    templatePreviewSampleEntry: readStringEnv(
      "HOTEL_TEMPLATE_PREVIEW_SAMPLE_ENTRY",
      "Viernes, 25 de Diciembre de 2026 a las 10:00",
    ),
    templatePreviewSampleExit: readStringEnv(
      "HOTEL_TEMPLATE_PREVIEW_SAMPLE_EXIT",
      "Sábado, 26 de Diciembre de 2026 a las 10:00",
    ),
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

export function isContextualContractAcceptance(message: string): boolean {
  const normalized = normalizeMessage(message);
  return [
    "esta bien",
    "esta ok",
    "ok",
    "vale",
    "de acuerdo",
    "perfecto",
    "correcto",
    "si",
  ].includes(normalized);
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
    "Antes de confirmar la reserva, necesitamos que leas y aceptes el contrato de admisión e ingreso y las condiciones del hotel:",
    config.contractUrl,
    "",
    "¿Confirmas que lo has leído y aceptas las condiciones?",
  ].join("\n");
}

export function buildReservationConfirmationTemplate(
  proposal: PendingReservationProposal,
): string {
  return renderReservationConfirmationTemplate(reservationTemplateInputFromProposal(proposal));
}
