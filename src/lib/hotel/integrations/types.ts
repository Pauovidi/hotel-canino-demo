export type HotelSlot = "morning" | "afternoon";

export type ReservationStatus =
  | "pending"
  | "available"
  | "no_availability"
  | "confirmed"
  | "cancelled"
  | "needs_review";

export type TransportMode = "mock" | "real" | "hybrid";

export interface HotelRuntimeFlags {
  useMockEmailInput: boolean;
  useMockWhatsApp: boolean;
  useRealGoogleSheets: boolean;
  useRealReminders: boolean;
  useMockPersistence: boolean;
}

export interface HotelColorMapping {
  pending: string;
  available: string;
  noAvailability: string;
  confirmed: string;
  reminder: string;
  review: string;
  header: string;
}

export interface HotelPricingBand {
  dogs: 1 | 2 | 3 | 4;
  baseRate: number;
  halfDaySupplement: number;
}

export interface HotelDemoConfig {
  bookingFormUrl: string;
  defaultTimezone: string;
  defaultCapacityPerMonth: number;
  overflowCapacityPerMonth: number;
  slotLabels: Record<HotelSlot, string>;
  sheetNaming:
    | "yyyy-mm"
    | "spanish-month"
    | "uppercase-spanish-month-year";
  pricingBands: HotelPricingBand[];
  colorMapping: HotelColorMapping;
}

export interface ReservationIdentity {
  phoneE164?: string;
  petKey: string;
  entryDate: string;
}

export interface DemoReservationRecord {
  id: string;
  petKey: string;
  petName: string;
  ownerName?: string;
  phoneE164?: string;
  entryDate: string;
  entrySlot: HotelSlot;
  entryTime?: string;
  originalRequestedCheckInTime?: string;
  normalizedCheckInTime?: string;
  checkInTimeWasAdjusted?: boolean;
  checkInTimeAdjustmentMessage?: string;
  exitDate: string;
  exitSlot: HotelSlot;
  exitTime?: string;
  originalRequestedCheckOutTime?: string;
  normalizedCheckOutTime?: string;
  checkOutTimeWasAdjusted?: boolean;
  checkOutTimeAdjustmentMessage?: string;
  dogs: number;
  ownerEmail?: string;
  foodNotes?: string;
  medicationNotes?: string;
  wantsVisit?: boolean | null;
  priceSource?: "calculated";
  notes?: string;
  bathRequested?: boolean;
  specialNotes?: string;
  manualFollowupRequired?: boolean;
  cancellationRequestedAt?: string;
  cancellationCompletedAt?: string;
  reminderSentAt?: string;
  sheetRegistration?: SheetReservationRegistration;
  status: ReservationStatus;
  source: "email" | "manual" | "mock";
  sheetName?: string;
  price?: number;
  needsManualReview?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MonthOccupancySnapshot {
  monthKey: string;
  sheetName: string;
  capacityBySlot: Record<HotelSlot, number>;
  occupiedByDate: Record<string, Record<HotelSlot, number>>;
  reservations: DemoReservationRecord[];
  colorPlan: SheetColorPlan[];
}

export interface SheetColorPlan {
  row: number;
  column: number;
  color: string;
  label: string;
}

export interface SheetWritePlan {
  sheetName: string;
  reservationId: string;
  petName: string;
  rowHint?: number;
  colorPlan: SheetColorPlan[];
  cellUpdates: SheetCellUpdate[];
  metadataUpdates: SheetCellMetadataUpdate[];
}

export interface SheetCellUpdate {
  cell: string;
  value: string;
}

export interface SheetCellMetadataUpdate {
  cell: string;
  note: string;
}

export interface SheetReservationRegistration {
  spreadsheetId?: string;
  sheetName: string;
  reservationId: string;
  rowHint?: number;
  cells: string[];
  writtenAt: string;
}

export interface SheetsCancellationResult {
  ok: boolean;
  reservationId: string;
  sheetName?: string;
  rowHint?: number;
  clearedCells: string[];
  metadataUpdates: SheetCellMetadataUpdate[];
  mode: TransportMode;
  cancelledAt: string;
}

export interface ReminderJob {
  id: string;
  reservationId: string;
  petName: string;
  ownerName?: string;
  phoneE164?: string;
  dueAt: string;
  reminderWindowStartsAt: string;
  entryDate: string;
  entrySlot: HotelSlot;
  status: "queued" | "sent" | "paused";
  channel: "whatsapp" | "email" | "internal";
  notes?: string;
  sentAt?: string;
  reminderSentAt?: string;
}

export interface DemoLogEntry {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface SheetsAvailabilityInput {
  entryDate: string;
  entrySlot: HotelSlot;
  exitDate: string;
  exitSlot: HotelSlot;
  dogs: number;
}

export interface SheetsAvailabilitySuggestedUnit {
  rowIndex: number;
  label: string;
  sourceLabel?: string;
  rowIndices?: number[];
}

export interface SheetsAvailabilityDebugColumn {
  columnIndex: number;
  columnLetter: string;
  date: string;
  slot: HotelSlot;
}

export interface SheetsAvailabilityDebugBlockedCell {
  cell: string;
  columnIndex: number;
  date: string;
  slot: HotelSlot;
  value: string;
}

export interface SheetsAvailabilityDebugRow {
  rowIndex: number;
  rowIndices?: number[];
  label?: string;
  sourceLabel?: string;
  analyzedColumns: string[];
  occupiedSlots?: string[];
  conflictingSlots?: string[];
  blockedCells: SheetsAvailabilityDebugBlockedCell[];
  status: "free" | "occupied" | "ignored";
  reason?: string;
}

export interface SheetsAvailabilityDebugInfo {
  monthKey: string;
  sheetName: string;
  checkedWindow: {
    entryDate: string;
    entrySlot: HotelSlot;
    exitDate: string;
    exitSlot: HotelSlot;
    dogs: number;
  };
  requestedSlots?: string[];
  analyzedColumns: SheetsAvailabilityDebugColumn[];
  analyzedRows: SheetsAvailabilityDebugRow[];
  summary: string;
}

export interface SheetsAvailabilityResult {
  available: boolean;
  conflicts: string[];
  remainingByDate: Record<string, Record<HotelSlot, number>>;
  monthKey: string;
  sheetName: string;
  suggestedUnit?: SheetsAvailabilitySuggestedUnit;
  suggestedUnits?: SheetsAvailabilitySuggestedUnit[];
  debug?: SheetsAvailabilityDebugInfo;
}

export interface SheetsWriteResult {
  ok: boolean;
  reservationId: string;
  sheetName: string;
  petName: string;
  rowHint?: number;
  colorPlan: SheetColorPlan[];
  cellUpdates: SheetCellUpdate[];
  metadataUpdates: SheetCellMetadataUpdate[];
  mode: TransportMode;
}

export interface ReminderCreationInput {
  reservation: DemoReservationRecord;
  dueOffsetHours?: number;
}

export interface WhatsappMessagePayload {
  reservation: DemoReservationRecord;
  availability: SheetsAvailabilityResult | null;
  price: number | null;
  reviewReasons: string[];
  formUrl: string;
}
