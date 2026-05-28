import { randomUUID } from "node:crypto";
import { upsertReservation } from "@/lib/hotel/application/demo-store";
import {
  upsertClientFromConfirmedReservation,
  type ClientUpsertFromConfirmedReservationInput,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
import {
  mapLegacyAvailabilityToDomain,
  toLegacyReservationRecord,
} from "@/lib/hotel/application/integration-bridge";
import { getHotelFeatureFlags } from "@/lib/hotel/config";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import { buildReservationIdentity } from "@/lib/hotel/domain/identifiers";
import { buildGoogleSheetAdapter, buildMockSheetAdapter } from "@/lib/hotel/sheets";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";
import type { ConversationNluResult } from "./nlu";
import type {
  ConversationRecord,
  PendingReservationProposal,
} from "./types";

const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

export interface WhatsAppReservationBridgeDeps {
  now?: () => Date;
  buildSheetAdapter?: () => Promise<SheetAdapter>;
  upsertReservationRecord?: (reservation: ReservationRecord) => Promise<void>;
  upsertClientFromConfirmedReservation?: (
    input: ClientUpsertFromConfirmedReservationInput,
  ) => Promise<ClientUpsertFromConfirmedReservationResult>;
}

export interface ReservationProposalOutcome {
  kind: "created" | "missing_data" | "manual_review" | "no_availability" | "failed";
  reply: string;
  proposal?: PendingReservationProposal;
  handoff?: boolean;
  eventPayload?: Record<string, unknown>;
}

export interface ReservationConfirmationOutcome {
  kind: "confirmed" | "missing_proposal" | "expired" | "manual_review" | "no_availability" | "failed";
  reply: string;
  proposal?: PendingReservationProposal;
  reservation?: ReservationRecord;
  clientDirectoryUpsert?: ClientUpsertFromConfirmedReservationResult;
  handoff?: boolean;
  eventPayload?: Record<string, unknown>;
}

interface ReservationRequestDetails {
  petName: string;
  checkIn: string;
  checkOut: string;
  checkInSlot: "morning" | "afternoon";
  checkOutSlot: "morning" | "afternoon";
  petCount: number;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeSensitiveId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }

  return "unknown_error";
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function parseDateRange(message: string): { checkIn: string; checkOut: string } | undefined {
  const text = normalize(message);
  const sameMonth = text.match(
    /\b(?:del|desde)\s+(\d{1,2})\s+(?:al|hasta)\s+(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/,
  );

  if (sameMonth) {
    const startDay = Number.parseInt(sameMonth[1], 10);
    const endDay = Number.parseInt(sameMonth[2], 10);
    const month = MONTHS[sameMonth[3]];
    const year = Number.parseInt(sameMonth[4], 10);
    const checkIn = month ? isoDate(year, month, startDay) : undefined;
    const checkOut = month ? isoDate(year, month, endDay) : undefined;

    return checkIn && checkOut && checkOut > checkIn ? { checkIn, checkOut } : undefined;
  }

  const explicitMonths = text.match(
    /\b(?:del|desde)\s+(\d{1,2})\s+de\s+([a-z]+)\s+(?:al|hasta)\s+(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/,
  );

  if (explicitMonths) {
    const startDay = Number.parseInt(explicitMonths[1], 10);
    const startMonth = MONTHS[explicitMonths[2]];
    const endDay = Number.parseInt(explicitMonths[3], 10);
    const endMonth = MONTHS[explicitMonths[4]];
    const year = Number.parseInt(explicitMonths[5], 10);
    const checkIn = startMonth ? isoDate(year, startMonth, startDay) : undefined;
    const checkOut = endMonth ? isoDate(year, endMonth, endDay) : undefined;

    return checkIn && checkOut && checkOut > checkIn ? { checkIn, checkOut } : undefined;
  }

  return undefined;
}

function extractPetName(message: string, fallback?: string): string | undefined {
  const match =
    message.match(
      /\b(?:para|perro|perra|mascota|se llama)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\s+(?:del|desde)\b/iu,
    ) ??
    message.match(/\b(?:para|perro|perra|mascota|se llama)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\b/iu);
  const raw = match?.[1]?.trim() ?? fallback?.trim();

  if (!raw) {
    return undefined;
  }

  return raw.replace(/\s+/g, " ");
}

function extractPetCount(message: string): number {
  const normalized = normalize(message);
  if (/\b(2|dos)\s+perr/.test(normalized)) {
    return 2;
  }
  if (/\b(3|tres)\s+perr/.test(normalized)) {
    return 3;
  }
  if (/\b(4|cuatro)\s+perr/.test(normalized)) {
    return 4;
  }

  return 1;
}

export function extractReservationRequestDetails(
  message: string,
  nlu: ConversationNluResult,
): ReservationRequestDetails | undefined {
  const dateRange = parseDateRange(message);
  const petName = extractPetName(message, nlu.slots.petName);

  if (!dateRange || !petName) {
    return undefined;
  }

  return {
    petName,
    checkIn: dateRange.checkIn,
    checkOut: dateRange.checkOut,
    checkInSlot: "morning",
    checkOutSlot: "afternoon",
    petCount: extractPetCount(message),
  };
}

function formatDateRange(checkIn: string, checkOut: string): string {
  const entry = new Date(`${checkIn}T00:00:00.000Z`);
  const exit = new Date(`${checkOut}T00:00:00.000Z`);
  const sameMonth =
    entry.getUTCFullYear() === exit.getUTCFullYear() &&
    entry.getUTCMonth() === exit.getUTCMonth();
  const monthFormatter = new Intl.DateTimeFormat("es-ES", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const fullFormatter = new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  if (sameMonth) {
    return `${entry.getUTCDate()} al ${exit.getUTCDate()} de ${monthFormatter.format(exit)}`;
  }

  return `${fullFormatter.format(entry)} al ${fullFormatter.format(exit)}`;
}

function buildProposalReply(proposal: PendingReservationProposal): string {
  return `Tenemos disponibilidad para ${proposal.petName} del ${formatDateRange(
    proposal.checkIn,
    proposal.checkOut,
  )}. ¿Quieres que dejemos la reserva anotada?`;
}

function buildConfirmationReply(proposal: PendingReservationProposal): string {
  return `Perfecto, la reserva de ${proposal.petName} del ${formatDateRange(
    proposal.checkIn,
    proposal.checkOut,
  )} queda anotada. El equipo la revisará y la incorporará a Gestet si corresponde.`;
}

function getDefaultBuildSheetAdapter() {
  return getHotelFeatureFlags().useGoogleSheetsReal
    ? buildGoogleSheetAdapter
    : () => buildMockSheetAdapter("hotel-whatsapp-reservation-bridge.json");
}

function proposalIsLive(
  proposal: PendingReservationProposal | undefined,
  now: Date,
): boolean {
  return (
    proposal?.status === "proposed" &&
    new Date(proposal.expiresAt).getTime() > now.getTime()
  );
}

function buildFailedClientUpsertResult(error: unknown): ClientUpsertFromConfirmedReservationResult {
  return {
    kind: "failed",
    clientStatus: "unknown",
    warning: safeErrorCode(error),
    source: "google_sheets_client_directory",
  };
}

function proposalHasRequiredData(
  proposal: PendingReservationProposal,
  conversation: ConversationRecord,
): boolean {
  return (
    proposal.conversationId === conversation.id &&
    Boolean(proposal.petName.trim()) &&
    Boolean(proposal.checkIn) &&
    Boolean(proposal.checkOut) &&
    Boolean(proposal.checkInSlot) &&
    Boolean(proposal.checkOutSlot) &&
    proposal.petCount > 0
  );
}

function toReservationRecord(input: {
  conversation: ConversationRecord;
  proposal: PendingReservationProposal;
  availability: Awaited<ReturnType<SheetAdapter["checkAvailability"]>>;
  writeResult?: SheetsWriteResult;
  nowIso: string;
}): ReservationRecord {
  const ownerName =
    input.conversation.clientName ??
    input.conversation.displayName ??
    input.conversation.customerName ??
    "Cliente WhatsApp";
  const identityTrace = buildReservationIdentity({
    petName: input.proposal.petName,
    phone: input.conversation.phoneE164,
    ownerName,
    checkInDate: input.proposal.checkIn,
    checkInSlot: input.proposal.checkInSlot,
  });

  return {
    reservationId: identityTrace.reservationId,
    petKey: identityTrace.petKey,
    identityTrace,
    workflowState: "confirmed",
    workflowTrail: [
      {
        from: "available",
        to: "confirmed",
        at: input.nowIso,
        reason: "Reserva confirmada explicitamente desde WhatsApp.",
      },
    ],
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: input.proposal.requestedAt,
    updatedAt: input.nowIso,
    ownerName,
    ownerEmail: input.conversation.clientEmail,
    petName: input.proposal.petName,
    phone: input.conversation.phoneE164,
    checkInDate: input.proposal.checkIn,
    checkInSlot: input.proposal.checkInSlot,
    checkOutDate: input.proposal.checkOut,
    checkOutSlot: input.proposal.checkOutSlot,
    petCount: input.proposal.petCount,
    notes: "Reserva creada desde WhatsApp por el chatbot. Pendiente de incorporacion/revision Gestet.",
    reviewFlags: [],
    availability: mapLegacyAvailabilityToDomain(input.availability, false),
    sheetRegistration: input.writeResult
      ? {
          sheetName: input.writeResult.sheetName,
          reservationId: input.writeResult.reservationId,
          rowHint: input.writeResult.rowHint,
          cells: input.writeResult.cellUpdates.map((update) => update.cell),
          writtenAt: input.nowIso,
        }
      : undefined,
  };
}

export async function createPendingReservationProposal(input: {
  conversation: ConversationRecord;
  inboundMessageId: string;
  message: string;
  nlu: ConversationNluResult;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<ReservationProposalOutcome> {
  const now = input.deps?.now?.() ?? new Date();
  const nowIso = now.toISOString();

  if (input.conversation.clientStatus === "blocked" || input.conversation.clientStatus === "ambiguous") {
    return {
      kind: "manual_review",
      handoff: true,
      reply: "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.",
      eventPayload: {
        clientStatus: input.conversation.clientStatus,
        reason: "client_directory_guardrail",
      },
    };
  }

  const details = extractReservationRequestDetails(input.message, input.nlu);
  if (!details) {
    return {
      kind: "missing_data",
      reply:
        "Para comprobar disponibilidad necesito fechas completas con año y el nombre del perro. Por ejemplo: “Quiero reservar para Kira del 29 al 31 de diciembre de 2026”.",
      eventPayload: {
        reason: "missing_pet_or_dates",
      },
    };
  }

  try {
    const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
    const availability = await adapter.checkAvailability({
      entryDate: details.checkIn,
      entrySlot: details.checkInSlot,
      exitDate: details.checkOut,
      exitSlot: details.checkOutSlot,
      dogs: details.petCount,
    });

    if (!availability.available) {
      return {
        kind: "no_availability",
        handoff: true,
        reply:
          "Ahora mismo no puedo dejar esa reserva anotada automáticamente porque no veo disponibilidad clara. Lo revisa una persona del equipo y te contestamos por aquí.",
        eventPayload: {
          reason: "no_availability",
          conflicts: availability.conflicts,
          monthKey: availability.monthKey,
        },
      };
    }

    const proposal: PendingReservationProposal = {
      proposalId: `proposal_${randomUUID()}`,
      conversationId: input.conversation.id,
      phoneNormalized: input.conversation.phoneNormalized,
      clientStatus: input.conversation.clientStatus ?? "unknown",
      clientName: input.conversation.clientName,
      petName: details.petName,
      checkIn: details.checkIn,
      checkOut: details.checkOut,
      checkInSlot: details.checkInSlot,
      checkOutSlot: details.checkOutSlot,
      petCount: details.petCount,
      requestedAt: nowIso,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
      availabilitySnapshot: {
        monthKey: availability.monthKey,
        available: availability.available,
        conflictCount: availability.conflicts.length,
      },
      status: "proposed",
      source: "whatsapp",
      createdFromMessageId: input.inboundMessageId,
    };

    return {
      kind: "created",
      proposal,
      reply: buildProposalReply(proposal),
      eventPayload: {
        proposalId: proposal.proposalId,
        petName: proposal.petName,
        checkIn: proposal.checkIn,
        checkOut: proposal.checkOut,
        petCount: proposal.petCount,
        monthKey: availability.monthKey,
        availabilityChecked: true,
      },
    };
  } catch (error) {
    return {
      kind: "failed",
      handoff: true,
      reply:
        "No he podido comprobar la disponibilidad con seguridad. Lo revisa una persona del equipo y te contestamos por aquí.",
      eventPayload: {
        reason: "availability_check_failed",
        errorCode: safeErrorCode(error),
      },
    };
  }
}

export async function confirmPendingReservationProposal(input: {
  conversation: ConversationRecord;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<ReservationConfirmationOutcome> {
  const now = input.deps?.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const proposal = input.conversation.pendingReservationProposal;

  if (input.conversation.clientStatus === "blocked" || input.conversation.clientStatus === "ambiguous") {
    return {
      kind: "manual_review",
      handoff: true,
      reply: "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.",
      proposal,
      eventPayload: {
        clientStatus: input.conversation.clientStatus,
        reason: "client_directory_guardrail",
      },
    };
  }

  if (!proposal) {
    return {
      kind: "missing_proposal",
      reply:
        "Para confirmarla necesito primero comprobar fechas y disponibilidad. ¿Qué fechas necesitas?",
      eventPayload: {
        reason: "missing_pending_proposal",
      },
    };
  }

  if (!proposalHasRequiredData(proposal, input.conversation)) {
    return {
      kind: "missing_proposal",
      reply:
        "Para confirmarla necesito primero comprobar fechas y disponibilidad. ¿Qué fechas necesitas?",
      proposal: {
        ...proposal,
        status: "failed",
        failureReason: "invalid_pending_proposal",
      },
      eventPayload: {
        proposalId: proposal.proposalId,
        reason: "invalid_pending_proposal",
      },
    };
  }

  if (proposal.status === "confirmed" && proposal.reservationId) {
    return {
      kind: "confirmed",
      reply: buildConfirmationReply(proposal),
      proposal,
      eventPayload: {
        proposalId: proposal.proposalId,
        reservationIdSummary: summarizeSensitiveId(proposal.reservationId),
        reason: "already_confirmed",
      },
    };
  }

  if (!proposalIsLive(proposal, now)) {
    return {
      kind: "expired",
      reply:
        "La propuesta de reserva anterior ya no está vigente. Para confirmarla necesito volver a comprobar fechas y disponibilidad.",
      proposal: {
        ...proposal,
        status: "expired",
        failureReason: "proposal_expired",
      },
      eventPayload: {
        proposalId: proposal.proposalId,
        reason: "proposal_expired",
      },
    };
  }

  try {
    const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
    const availability = await adapter.checkAvailability({
      entryDate: proposal.checkIn,
      entrySlot: proposal.checkInSlot,
      exitDate: proposal.checkOut,
      exitSlot: proposal.checkOutSlot,
      dogs: proposal.petCount,
    });

    if (!availability.available) {
      return {
        kind: "no_availability",
        handoff: true,
        reply:
          "Acabo de volver a comprobar disponibilidad y ya no puedo dejarla anotada automáticamente. Lo revisa una persona del equipo y te contestamos por aquí.",
        proposal: {
          ...proposal,
          status: "failed",
          failureReason: "availability_lost_before_write",
        },
        eventPayload: {
        proposalId: proposal.proposalId,
        reason: "availability_lost_before_write",
          conflictCount: availability.conflicts.length,
      },
    };
    }

    const previewReservation = toReservationRecord({
      conversation: input.conversation,
      proposal,
      availability,
      nowIso,
    });
    const writeResult = await adapter.writeReservation(
      toLegacyReservationRecord(previewReservation, "confirmada"),
    );
    const reservation = toReservationRecord({
      conversation: input.conversation,
      proposal,
      availability,
      writeResult,
      nowIso,
    });

    await (input.deps?.upsertReservationRecord ?? upsertReservation)(reservation);
    let clientDirectoryUpsert: ClientUpsertFromConfirmedReservationResult | undefined;
    try {
      clientDirectoryUpsert = await (
        input.deps?.upsertClientFromConfirmedReservation ??
        upsertClientFromConfirmedReservation
      )({
        phoneE164: input.conversation.phoneE164,
        phoneNormalized: input.conversation.phoneNormalized,
        clientName:
          input.conversation.clientName ??
          input.conversation.displayName ??
          input.conversation.customerName,
        email: input.conversation.clientEmail,
        reservationId: reservation.reservationId,
        petName: proposal.petName,
        checkIn: proposal.checkIn,
        checkOut: proposal.checkOut,
        source: "whatsapp_reservation",
        now,
      });
    } catch (error) {
      clientDirectoryUpsert = buildFailedClientUpsertResult(error);
    }

    const confirmedProposal: PendingReservationProposal = {
      ...proposal,
      status: "confirmed",
      reservationId: reservation.reservationId,
    };

    return {
      kind: "confirmed",
      proposal: confirmedProposal,
      reservation,
      clientDirectoryUpsert,
      reply: buildConfirmationReply(confirmedProposal),
      eventPayload: {
        proposalId: proposal.proposalId,
        reservationIdSummary: summarizeSensitiveId(reservation.reservationId),
        cellsWritten: reservation.sheetRegistration?.cells.length ?? 0,
        clientDirectoryUpsert: clientDirectoryUpsert
          ? {
              kind: clientDirectoryUpsert.kind,
              clientStatus: clientDirectoryUpsert.clientStatus,
              rowNumber: clientDirectoryUpsert.rowNumber,
              sheetName: clientDirectoryUpsert.sheetName,
              matchCount: clientDirectoryUpsert.matchCount,
              warning: clientDirectoryUpsert.warning,
            }
          : undefined,
      },
    };
  } catch (error) {
    return {
      kind: "failed",
      handoff: true,
      reply:
        "No he podido anotar la reserva con seguridad, así que no la marco como confirmada. Lo revisa una persona del equipo y te contestamos por aquí.",
      proposal: {
        ...proposal,
        status: "failed",
        failureReason: "sheet_write_failed",
      },
      eventPayload: {
        proposalId: proposal.proposalId,
        reason: "sheet_write_failed",
        errorCode: safeErrorCode(error),
      },
    };
  }
}
