import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import { getClientRequestsConfig } from "./client-requests";
import {
  renderPostStayFollowupTemplate,
  renderPositiveReviewRequestTemplate,
  renderPrearrivalReminderTemplate,
} from "./client-templates";
import { readScheduledMessagesConfig } from "./scheduled-messages";

export type ClientRequestJobKind = "prearrival_reminder" | "post_stay_followup";

export interface ClientRequestJobCandidate {
  kind: ClientRequestJobKind;
  reservationId: string;
  phone?: string;
  petName?: string;
  scheduledFor: string;
  dryRun: boolean;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateAtUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(dateAtUtc(value));
}

function petNames(reservation: ReservationRecord): string[] {
  return reservation.petNames?.length
    ? reservation.petNames
    : [reservation.petName ?? "tu mascota"];
}

function entryText(reservation: ReservationRecord): string {
  const date = formatDate(reservation.checkInDate);
  return reservation.checkInTime ? `${date} a las ${reservation.checkInTime}` : date;
}

function isConfirmed(reservation: ReservationRecord): boolean {
  return reservation.status === "confirmada" || reservation.workflowState === "confirmed";
}

export function buildPrearrivalReminderMessage(reservation: ReservationRecord): string {
  return renderPrearrivalReminderTemplate({
    clientName: reservation.ownerName,
    petNames: petNames(reservation),
    entryText: entryText(reservation),
  });
}

export function buildPostStayFollowupMessage(reservation: ReservationRecord): string {
  return renderPostStayFollowupTemplate({
    clientName: reservation.ownerName,
    petNames: petNames(reservation),
  });
}

export function isPositivePostStayReply(message: string): boolean {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(si|sí|todo bien|muy bien|genial|perfecto|fenomenal|estupendo|muy contentos|todo perfecto)\b/.test(
    normalized,
  );
}

export function buildPositivePostStayReviewReply(message: string): string | undefined {
  return isPositivePostStayReply(message) ? renderPositiveReviewRequestTemplate() : undefined;
}

export function selectPrearrivalReminderCandidates(
  reservations: ReservationRecord[],
  now = new Date(),
): ClientRequestJobCandidate[] {
  const config = getClientRequestsConfig();
  const scheduledConfig = readScheduledMessagesConfig();
  if (!config.reservationRemindersEnabled) {
    return [];
  }

  const daysBefore = scheduledConfig.reservationReminderDaysBefore;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetStart = startOfToday + daysBefore * DAY_MS;
  const targetEnd = targetStart + DAY_MS;

  return reservations
    .filter((reservation) => isConfirmed(reservation))
    .filter((reservation) => !reservation.prearrivalReminderSentAt)
    .filter((reservation) => {
      const entryTime = dateAtUtc(reservation.checkInDate).getTime();
      return entryTime >= targetStart && entryTime < targetEnd;
    })
    .map((reservation) => ({
      kind: "prearrival_reminder",
      reservationId: reservation.reservationId,
      phone: reservation.phone,
      petName: reservation.petName,
      scheduledFor: now.toISOString(),
      dryRun: config.reminderDryRun,
      message: buildPrearrivalReminderMessage(reservation),
    }));
}

export function selectPostStayFollowupCandidates(
  reservations: ReservationRecord[],
  now = new Date(),
): ClientRequestJobCandidate[] {
  const config = getClientRequestsConfig();
  const scheduledConfig = readScheduledMessagesConfig();
  if (!config.postStayFollowupsEnabled) {
    return [];
  }
  const targetStart =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    scheduledConfig.postStayFollowupDaysAfter * DAY_MS;
  const targetEnd = targetStart + DAY_MS;

  return reservations
    .filter((reservation) => isConfirmed(reservation))
    .filter(
      (reservation) =>
        !config.postStayFollowupOnlyNewClients || reservation.clientKind === "new",
    )
    .filter((reservation) => !reservation.postStayFollowupSentAt)
    .filter((reservation) => {
      const checkoutTime = dateAtUtc(reservation.checkOutDate).getTime();
      return checkoutTime >= targetStart && checkoutTime < targetEnd;
    })
    .map((reservation) => ({
      kind: "post_stay_followup",
      reservationId: reservation.reservationId,
      phone: reservation.phone,
      petName: reservation.petName,
      scheduledFor: now.toISOString(),
      dryRun: config.followupDryRun,
      message: buildPostStayFollowupMessage(reservation),
    }));
}
