import type {
  HotelSlot,
  ReservationFlowTurn,
} from "./slots";
import type {
  ReservationReviewFlag,
  ReservationReviewState,
  ReservationSource,
  ReservationStatus,
  ReservationWorkflowState,
  ReservationWorkflowTransition,
} from "./states";
import type { ReservationIdentityTrace } from "./identifiers";
import type { SheetReservationRegistration } from "../integrations/types";

export interface HotelCapacityConfig {
  standardRoomsPerSlot: number;
  overflowRoomsPerSlot: number;
  allowOverflow: boolean;
  maxPetsPerRoom: number;
}

export interface PricingTier {
  petCount: 1 | 2 | 3 | 4;
  nightlyRate: number;
}

export interface HalfDaySupplementConfig {
  enabled: boolean;
  label: string;
  amount: number;
}

export interface HotelConfig {
  hotelName: string;
  bookingFormUrl: string;
  whatsappUrl: string;
  whatsappPhone: string;
  baseCountryCode: string;
  reminderLeadHours: number;
  defaultTimezone: string;
  defaultMonthSheetPrefix: string;
  receptionWindows: Record<HotelSlot, { start: string; end: string }>;
  slotLabels: Record<HotelSlot, string>;
  capacity: HotelCapacityConfig;
  pricing: {
    tiers: PricingTier[];
    halfDaySupplement: HalfDaySupplementConfig;
    dayGuarderiaPrice: number;
    guarderiaBono10Price: number;
  };
}

export interface HotelFeatureFlags {
  useMockEmailInput: boolean;
  useMockWhatsappSend: boolean;
  useGoogleSheetsReal: boolean;
  useRemindersReal: boolean;
  useDemoPersistence: boolean;
}

export interface HotelColorMapping {
  reservationStatus: Record<ReservationStatus, string>;
  reviewState: Record<ReservationReviewState, string>;
  occupancyState: {
    free: string;
    low: string;
    medium: string;
    high: string;
    full: string;
  };
  petCount: Record<1 | 2 | 3 | 4, string>;
  sheetState: Record<string, string>;
}

export interface IncomingReservationEmail {
  subject: string;
  rawText: string;
  receivedAt?: string;
  sourceMailbox?: string;
}

export interface ParsedReservationPet {
  name: string;
  sex?: string;
  breed?: string;
  rawLine?: string;
}

export interface ParsedReservationDraft {
  source: ReservationSource;
  subject?: string;
  rawText: string;
  reservationType?: "hotel";
  ownerName?: string;
  ownerEmail?: string;
  petName?: string;
  petSex?: string;
  petBreed?: string;
  pets?: ParsedReservationPet[];
  phone?: string;
  whatsapp?: string;
  checkInDate?: string;
  checkInTime?: string;
  originalRequestedCheckInTime?: string;
  normalizedCheckInTime?: string;
  checkInTimeWasAdjusted?: boolean;
  checkInTimeAdjustmentMessage?: string;
  checkInTurn?: ReservationFlowTurn;
  checkOutDate?: string;
  checkOutTime?: string;
  originalRequestedCheckOutTime?: string;
  normalizedCheckOutTime?: string;
  checkOutTimeWasAdjusted?: boolean;
  checkOutTimeAdjustmentMessage?: string;
  checkOutTurn?: ReservationFlowTurn;
  petCount?: number;
  notes?: string;
  language?: "es";
  reviewFlags: ReservationReviewFlag[];
  reviewState: ReservationReviewState;
  workflowState?: ReservationWorkflowState;
}

export interface ReservationStayRange {
  checkInDate: string;
  checkInSlot: HotelSlot;
  checkOutDate: string;
  checkOutSlot: HotelSlot;
}

export type ReservationDraft = ParsedReservationDraft &
  ReservationStayRange & {
    reservationId: string;
    petKey: string;
  };

export interface AvailabilityDaySnapshot {
  date: string;
  morningOccupied: number;
  afternoonOccupied: number;
  morningCapacity: number;
  afternoonCapacity: number;
}

export interface AvailabilityResult {
  isAvailable: boolean;
  requiresReview: boolean;
  capacityPerSlot: number;
  overflowUsed: boolean;
  blockingDates: string[];
  snapshot: AvailabilityDaySnapshot[];
}

export interface PricingLineItem {
  code: string;
  label: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface PricingQuote {
  currency: "EUR";
  subtotal: number;
  supplements: number;
  total: number;
  lineItems: PricingLineItem[];
  assumptions: string[];
}

export interface ReservationRecord {
  reservationId: string;
  petKey: string;
  workflowState?: ReservationWorkflowState;
  workflowTrail?: ReservationWorkflowTransition[];
  identityTrace?: ReservationIdentityTrace;
  status: ReservationStatus;
  reviewState: ReservationReviewState;
  source: ReservationSource;
  createdAt: string;
  updatedAt: string;
  ownerName?: string;
  ownerEmail?: string;
  petName?: string;
  petNames?: string[];
  phone?: string;
  checkInDate: string;
  checkInTime?: string;
  checkInSlot: HotelSlot;
  originalRequestedCheckInTime?: string;
  normalizedCheckInTime?: string;
  checkInTimeWasAdjusted?: boolean;
  checkInTimeAdjustmentMessage?: string;
  checkOutDate: string;
  checkOutTime?: string;
  checkOutSlot: HotelSlot;
  originalRequestedCheckOutTime?: string;
  normalizedCheckOutTime?: string;
  checkOutTimeWasAdjusted?: boolean;
  checkOutTimeAdjustmentMessage?: string;
  petCount: number;
  foodNotes?: string;
  medicationNotes?: string;
  wantsVisit?: boolean | null;
  priceSource?: "calculated";
  priceNeedsReview?: boolean;
  conversationId?: string;
  clientKind?: "habitual" | "new" | "unknown";
  clientDirectoryUpsertKind?:
    | "created"
    | "created_pending_name"
    | "existing"
    | "skipped_ambiguous"
    | "skipped_blocked"
    | "skipped_invalid_phone"
    | "failed";
  clientDirectoryUpsertStatus?: "created" | "existing" | "pending" | "skipped" | "failed";
  clientDirectoryClientName?: string;
  clientDirectorySheetName?: string;
  clientDirectorySheetRow?: number;
  clientDirectoryWarning?: string;
  notes?: string;
  bathRequested?: boolean;
  specialNotes?: string;
  manualFollowupRequired?: boolean;
  cancellationRequestedAt?: string;
  cancellationCompletedAt?: string;
  reminderSentAt?: string;
  sheetRegistration?: SheetReservationRegistration;
  reviewFlags: ReservationReviewFlag[];
  availability?: AvailabilityResult;
  pricing?: PricingQuote;
}

export interface ReminderJob {
  reminderId: string;
  reservationId: string;
  petName?: string;
  ownerName?: string;
  scheduledFor: string;
  leadHours: number;
  status: "pendiente" | "enviado" | "fallido";
  channel: "whatsapp" | "email";
  messagePreview: string;
  mode?: "mock" | "real" | "preview" | "manual";
  createdAt?: string;
  updatedAt?: string;
  sentAt?: string;
  failedAt?: string;
  attempts?: number;
  lastError?: string;
  trace?: Array<{
    at: string;
    event: string;
    message: string;
  }>;
}

export interface DemoPersistenceEnvelope<T> {
  id: string;
  createdAt: string;
  updatedAt: string;
  payload: T;
}

export interface DemoStatusCounters {
  pending: number;
  available: number;
  noAvailability: number;
  confirmed: number;
  cancelled: number;
}

export interface SheetMonthKey {
  year: number;
  month: number;
}

export interface GoogleSheetsMonthRequest extends SheetMonthKey {
  sheetName?: string;
}

export interface SheetsReservationWritePayload {
  reservationId: string;
  petKey: string;
  petName?: string;
  ownerName?: string;
  ownerEmail?: string;
  phone?: string;
  checkInDate: string;
  checkInSlot: HotelSlot;
  originalRequestedCheckInTime?: string;
  normalizedCheckInTime?: string;
  checkOutDate: string;
  checkOutSlot: HotelSlot;
  originalRequestedCheckOutTime?: string;
  normalizedCheckOutTime?: string;
  petCount: number;
  notes?: string;
  bathRequested?: boolean;
  specialNotes?: string;
  manualFollowupRequired?: boolean;
  cancellationRequestedAt?: string;
  cancellationCompletedAt?: string;
  reminderSentAt?: string;
  sheetRegistration?: SheetReservationRegistration;
  status: ReservationStatus;
  reviewState: ReservationReviewState;
  colorKey?: string;
}

export interface SheetsMonthSnapshot {
  sheetName: string;
  monthKey: string;
  capacityPerSlot: number;
  occupied: Record<string, { morning: number; afternoon: number }>;
}
