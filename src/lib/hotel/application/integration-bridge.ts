import { HOTEL_COLOR_MAPPING, getHotelRuntimeConfig } from "../config";
import type {
  AvailabilityResult,
  PricingQuote,
  ReservationRecord,
} from "../domain/contracts";
import type { ReservationStatus } from "../domain/states";
import type { DemoSheetWritePlan } from "./types";
import type {
  DemoReservationRecord,
  SheetsAvailabilityInput,
  SheetsAvailabilityResult,
  SheetWritePlan,
  WhatsappMessagePayload,
} from "../integrations/types";

function mapLegacyStatus(status: ReservationStatus): DemoReservationRecord["status"] {
  switch (status) {
    case "disponible":
      return "available";
    case "sin_disponibilidad":
      return "no_availability";
    case "confirmada":
      return "confirmed";
    case "cancelada":
      return "cancelled";
    case "pendiente":
    default:
      return "needs_review";
  }
}

export function toLegacyReservationRecord(
  reservation: ReservationRecord,
  status = reservation.status,
): DemoReservationRecord {
  return {
    id: reservation.reservationId,
    petKey: reservation.petKey,
    petName: reservation.petName ?? "Mascota",
    ownerName: reservation.ownerName,
    ownerEmail: reservation.ownerEmail,
    phoneE164: reservation.phone,
    entryDate: reservation.checkInDate,
    entrySlot: reservation.checkInSlot,
    entryTime: reservation.checkInTime,
    originalRequestedCheckInTime: reservation.originalRequestedCheckInTime,
    normalizedCheckInTime: reservation.normalizedCheckInTime,
    checkInTimeWasAdjusted: reservation.checkInTimeWasAdjusted,
    checkInTimeAdjustmentMessage: reservation.checkInTimeAdjustmentMessage,
    exitDate: reservation.checkOutDate,
    exitSlot: reservation.checkOutSlot,
    exitTime: reservation.checkOutTime,
    originalRequestedCheckOutTime: reservation.originalRequestedCheckOutTime,
    normalizedCheckOutTime: reservation.normalizedCheckOutTime,
    checkOutTimeWasAdjusted: reservation.checkOutTimeWasAdjusted,
    checkOutTimeAdjustmentMessage: reservation.checkOutTimeAdjustmentMessage,
    dogs: reservation.petCount,
    foodNotes: reservation.foodNotes,
    medicationNotes: reservation.medicationNotes,
    wantsVisit: reservation.wantsVisit,
    priceSource: reservation.priceSource,
    notes: reservation.notes,
    bathRequested: reservation.bathRequested,
    specialNotes: reservation.specialNotes,
    manualFollowupRequired: reservation.manualFollowupRequired,
    cancellationRequestedAt: reservation.cancellationRequestedAt,
    cancellationCompletedAt: reservation.cancellationCompletedAt,
    reminderSentAt: reservation.reminderSentAt,
    sheetRegistration: reservation.sheetRegistration,
    status: mapLegacyStatus(status),
    source:
      reservation.source === "demo"
        ? "mock"
        : reservation.source === "web"
          ? "email"
          : reservation.source,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    needsManualReview: reservation.reviewState === "necesita_revision",
    price: reservation.pricing?.total,
  };
}

export function toLegacyAvailabilityInput(
  reservation: ReservationRecord,
): SheetsAvailabilityInput {
  return {
    entryDate: reservation.checkInDate,
    entrySlot: reservation.checkInSlot,
    exitDate: reservation.checkOutDate,
    exitSlot: reservation.checkOutSlot,
    dogs: reservation.petCount,
  };
}

export function mapLegacyAvailabilityToDomain(
  availability: SheetsAvailabilityResult,
  requiresReview: boolean,
): AvailabilityResult {
  const runtimeConfig = getHotelRuntimeConfig();
  const capacityPerSlot = runtimeConfig.capacity.standardRoomsPerSlot;
  const snapshot = Object.entries(availability.remainingByDate)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, remaining]) => ({
      date,
      morningOccupied: Math.max(0, capacityPerSlot - (remaining.morning ?? 0)),
      afternoonOccupied: Math.max(0, capacityPerSlot - (remaining.afternoon ?? 0)),
      morningCapacity: capacityPerSlot,
      afternoonCapacity: capacityPerSlot,
    }));

  return {
    isAvailable: availability.available,
    requiresReview,
    capacityPerSlot,
    overflowUsed: false,
    blockingDates: snapshot
      .filter(
        (item) =>
          item.morningOccupied >= item.morningCapacity ||
          item.afternoonOccupied >= item.afternoonCapacity,
      )
      .map((item) => item.date),
    snapshot,
  };
}

export function mapDomainAvailabilityToLegacy(
  availability: AvailabilityResult | null | undefined,
): SheetsAvailabilityResult | null {
  if (!availability) {
    return null;
  }

  return {
    available: availability.isAvailable,
    conflicts: [],
    remainingByDate: Object.fromEntries(
      availability.snapshot.map((item) => [
        item.date,
        {
          morning: Math.max(0, item.morningCapacity - item.morningOccupied),
          afternoon: Math.max(0, item.afternoonCapacity - item.afternoonOccupied),
        },
      ]),
    ),
    monthKey:
      availability.snapshot[0]?.date.slice(0, 7) ??
      new Date().toISOString().slice(0, 7),
    sheetName:
      availability.snapshot[0]?.date.slice(0, 7) ??
      new Date().toISOString().slice(0, 7),
  };
}

export function mapLegacyWritePlanToDemoPlan(
  plan: SheetWritePlan,
  status: ReservationStatus,
): DemoSheetWritePlan {
  const colorKey =
    status === "confirmada"
      ? "reservado"
      : status === "sin_disponibilidad"
        ? "bloqueado"
        : status === "disponible"
          ? "disponible"
          : "overflow";

  return {
    sheetName: plan.sheetName,
    monthKey: plan.sheetName,
    prepared: status === "disponible" || status === "confirmada",
    colorKey,
    colorHex: HOTEL_COLOR_MAPPING.sheetState[colorKey] ?? HOTEL_COLOR_MAPPING.sheetState.reservado,
    petName: plan.petName,
    notes: [
      `Fila objetivo: ${plan.rowHint ?? "pendiente"}`,
      "Plan generado por el adapter de Google Sheets.",
    ],
    cellUpdates: plan.cellUpdates.map((update) => ({
      field: update.cell,
      value: update.value,
    })),
  };
}

export function buildWhatsAppOutputPayload(input: {
  reservation: ReservationRecord;
  availability: SheetsAvailabilityResult | null;
  pricing: PricingQuote | null;
  reviewFlags: string[];
}): WhatsappMessagePayload {
  return {
    reservation: toLegacyReservationRecord(input.reservation),
    availability: input.availability,
    price: input.pricing?.total ?? null,
    reviewReasons: input.reviewFlags,
    formUrl: getHotelRuntimeConfig().bookingFormUrl,
  };
}
