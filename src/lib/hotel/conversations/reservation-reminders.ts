import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import { getClientRequestsConfig } from "./client-requests";

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

function isConfirmed(reservation: ReservationRecord): boolean {
  return reservation.status === "confirmada" || reservation.workflowState === "confirmed";
}

export function buildPrearrivalReminderMessage(reservation: ReservationRecord): string {
  const petName = reservation.petName ?? "tu mascota";
  return [
    `Hola, os recordamos que ${petName} entra en Somos Muy Perros el ${formatDate(
      reservation.checkInDate,
    )}.`,
    "Si necesitais cambiar cualquier detalle, responded a este mensaje y el equipo lo revisara.",
  ].join("\n");
}

export function buildPostStayFollowupMessage(reservation: ReservationRecord): string {
  const petName = reservation.petName ?? "tu mascota";
  return [
    `Hola, esperamos que ${petName} haya descansado bien despues de su estancia en Somos Muy Perros.`,
    "Gracias por confiar en nosotros. Si necesitais cualquier cosa, estamos por aqui.",
  ].join("\n");
}

export function selectPrearrivalReminderCandidates(
  reservations: ReservationRecord[],
  now = new Date(),
): ClientRequestJobCandidate[] {
  const config = getClientRequestsConfig();
  if (!config.reservationRemindersEnabled) {
    return [];
  }

  const leadHours = Number(process.env.HOTEL_RESERVATION_REMINDER_LEAD_HOURS ?? 24);
  const minDue = now.getTime();
  const maxDue = now.getTime() + leadHours * 60 * 60 * 1000;

  return reservations
    .filter((reservation) => isConfirmed(reservation))
    .filter((reservation) => !reservation.prearrivalReminderSentAt)
    .filter((reservation) => {
      const entryTime = dateAtUtc(reservation.checkInDate).getTime();
      return entryTime >= minDue && entryTime <= maxDue;
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
  if (!config.postStayFollowupsEnabled) {
    return [];
  }

  return reservations
    .filter((reservation) => isConfirmed(reservation))
    .filter((reservation) => !reservation.postStayFollowupSentAt)
    .filter((reservation) => {
      const checkoutTime = dateAtUtc(reservation.checkOutDate).getTime();
      return checkoutTime <= now.getTime() && checkoutTime >= now.getTime() - 14 * DAY_MS;
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
