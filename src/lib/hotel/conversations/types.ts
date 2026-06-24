export type ConversationMode = "bot" | "human";
export type ConversationSourceType =
  | "whatsapp"
  | "web"
  | "email"
  | "manual"
  | "demo"
  | "reservation"
  | "unknown";
export type MessageDirection = "inbound" | "outbound";
export type MessageSenderType = "user" | "bot" | "human" | "system";
export type MessageTransport = "whatsapp";
export type ConversationClientStatus = "known" | "unknown" | "ambiguous" | "blocked";
export type ConversationClientConfidence = "strong" | "medium" | "weak" | "none";
export type ConversationClientMatchType = "phone" | "email" | "name" | "none";
export type ConversationReservationClientKind = "habitual" | "new" | "unknown";
export type ConversationReservationAvailabilityStatus =
  | "pending"
  | "available"
  | "unavailable";
export type ConversationReservationStatus =
  | "asking_client_kind"
  | "asking_existing_email"
  | "collecting_owner"
  | "collecting_pet"
  | "collecting_dates"
  | "collecting_notes"
  | "collecting_visit"
  | "pending_availability"
  | "pending_confirmation"
  | "confirmed"
  | "rejected"
  | "no_availability";

export interface ConversationReservationFlow {
  flowId: string;
  status: ConversationReservationStatus;
  clientKind: ConversationReservationClientKind;
  email?: string;
  ownerName?: string;
  petName?: string;
  petNames?: string[];
  petBreeds?: string[];
  petCount?: number;
  petCountInference?: "names" | "explicit" | "names_and_explicit";
  petCountInconsistency?: {
    nameCount: number;
    statedCount: number;
  };
  checkInDate?: string;
  checkInTime?: string;
  checkInSlot?: "morning" | "afternoon";
  checkOutDate?: string;
  checkOutTime?: string;
  checkOutSlot?: "morning" | "afternoon";
  timePreferencePrompted?: boolean;
  pendingSharedTimeConfirmation?: string;
  foodNotes?: string;
  medicationNotes?: string;
  notes?: string;
  wantsVisit?: boolean | null;
  availabilityStatus?: ConversationReservationAvailabilityStatus;
  price?: number;
  priceSource?: "calculated";
  priceNeedsReview?: boolean;
  proposalId?: string;
  reservationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingPriceQuoteFlow {
  flowId: string;
  conversationId: string;
  phoneNormalized: string;
  status: "collecting_pet_count" | "needs_exact_date" | "quoted";
  source: "whatsapp";
  checkInDate?: string;
  checkOutDate?: string;
  checkInLabel?: string;
  checkOutLabel?: string;
  vagueDateMention?: string;
  needsExactDate?: boolean;
  petCount?: number;
  petBreeds?: string[];
  nights?: number;
  estimatedPrice?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PendingReservationProposal {
  proposalId: string;
  conversationId: string;
  phoneNormalized: string;
  clientStatus: ConversationClientStatus;
  clientName?: string;
  petName: string;
  petNames?: string[];
  checkIn: string;
  checkOut: string;
  checkInSlot: "morning" | "afternoon";
  checkOutSlot: "morning" | "afternoon";
  petCount: number;
  ownerName?: string;
  ownerEmail?: string;
  checkInTime?: string;
  checkOutTime?: string;
  price?: number;
  priceSource?: "calculated";
  priceNeedsReview?: boolean;
  wantsVisit?: boolean | null;
  foodNotes?: string;
  medicationNotes?: string;
  notes?: string;
  pricing?: import("@/lib/hotel/domain/contracts").PricingQuote;
  requestedAt: string;
  expiresAt: string;
  availabilitySnapshot?: unknown;
  status: "proposed" | "confirmed" | "expired" | "cancelled" | "failed";
  source: "whatsapp";
  createdFromMessageId: string;
  reservationId?: string;
  failureReason?: string;
  termsAccepted?: boolean;
  termsAcceptedAt?: string;
  termsVersion?: string;
  termsSource?: "whatsapp_link";
  termsUrl?: string;
  contractAcceptanceRequestedAt?: string;
}

export interface PendingReservationContext {
  contextId: string;
  conversationId: string;
  phoneNormalized: string;
  status: "collecting" | "fulfilled" | "expired" | "cancelled";
  source: "whatsapp";
  requestedAt: string;
  updatedAt: string;
  expiresAt: string;
  requestedFields: Array<"petName" | "dates">;
  createdFromMessageId: string;
  petCount?: number;
  petBreeds?: string[];
  checkInDate?: string;
  checkInLabel?: string;
  vagueDateMention?: string;
  needsExactDate?: boolean;
}

export type PendingReservationChangeStatus =
  | "identifying_reservation"
  | "collecting_change"
  | "awaiting_confirmation"
  | "confirmed"
  | "cancelled"
  | "manual_review";

export interface PendingReservationModificationFlow {
  flowId: string;
  conversationId: string;
  phoneNormalized: string;
  status: PendingReservationChangeStatus;
  source: "whatsapp";
  targetReservationId?: string;
  candidateReservationIds?: string[];
  petName?: string;
  currentCheckInDate?: string;
  currentCheckInTime?: string;
  currentCheckOutDate?: string;
  currentCheckOutTime?: string;
  requestedCheckInDate?: string;
  requestedCheckInTime?: string;
  requestedCheckOutDate?: string;
  requestedCheckOutTime?: string;
  requestedChanges?: Array<"dates" | "times" | "pet" | "notes" | "contact" | "cancellation">;
  requestedNotes?: string;
  availabilityStatus?: "pending" | "available" | "unavailable";
  oldPrice?: number;
  newPrice?: number;
  priceDelta?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  failureReason?: string;
}

export interface PendingReservationCancellationFlow {
  flowId: string;
  conversationId: string;
  phoneNormalized: string;
  status:
    | "identifying_reservation"
    | "awaiting_confirmation"
    | "confirmed"
    | "cancelled"
    | "manual_review";
  source: "whatsapp";
  targetReservationId?: string;
  candidateReservationIds?: string[];
  petName?: string;
  checkInDate?: string;
  checkInTime?: string;
  checkOutDate?: string;
  checkOutTime?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  failureReason?: string;
}

export type PendingBathOfferStatus =
  | "scheduled"
  | "offered"
  | "awaiting_size"
  | "awaiting_photo"
  | "quoted"
  | "declined"
  | "manual_review";

export interface PendingBathOfferFlow {
  flowId: string;
  conversationId: string;
  reservationId?: string;
  status: PendingBathOfferStatus;
  petNames: string[];
  size?: "small" | "medium" | "large";
  quotedPrice?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface PendingPostStayFollowupFlow {
  flowId: string;
  conversationId: string;
  reservationId?: string;
  status: "awaiting_feedback" | "positive_review_requested" | "manual_review";
  petNames: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface Conversation {
  id: string;
  phoneE164: string;
  phoneNormalized: string;
  displayName?: string;
  customerName?: string;
  petName?: string;
  channel?: string;
  status?: string;
  priority?: "low" | "normal" | "high" | "urgent" | string;
  tags?: string[];
  sourceType: ConversationSourceType;
  sourceRecordId?: string;
  reservationId?: string;
  clientStatus?: ConversationClientStatus;
  clientConfidence?: ConversationClientConfidence;
  clientMatchType?: ConversationClientMatchType;
  clientName?: string;
  clientEmail?: string;
  clientPets?: string[];
  clientPetsCount?: number;
  clientPetsMatchStatus?:
    | "exact"
    | "exact_or_token"
    | "token_subset_unique"
    | "probable_high_unique_token"
    | "exact_canonical"
    | "token_subset_unique_canonical"
    | "probable_high_unique_token_canonical"
    | "duplicate_clear_canonical"
    | "ambiguous_canonical"
    | "ambiguous"
    | "missing"
    | "manual_review";
  clientPetsMeta?: string;
  clientWarnings?: string[];
  clientSource?: "google_sheets_client_directory";
  clientSheetName?: string;
  clientSheetRow?: number;
  clientDirectoryUpsertKind?:
    | "created"
    | "created_pending_name"
    | "existing"
    | "skipped_ambiguous"
    | "skipped_blocked"
    | "skipped_invalid_phone"
    | "failed";
  clientDirectoryUpsertStatus?: "created" | "existing" | "pending" | "skipped" | "failed";
  clientDirectoryUpsertWarning?: string;
  pendingReservationProposal?: PendingReservationProposal;
  pendingReservationContext?: PendingReservationContext;
  pendingPriceQuoteFlow?: PendingPriceQuoteFlow;
  pendingReservationModificationFlow?: PendingReservationModificationFlow;
  pendingReservationCancellationFlow?: PendingReservationCancellationFlow;
  pendingBathOffer?: PendingBathOfferFlow;
  pendingPostStayFollowup?: PendingPostStayFollowupFlow;
  reservationFlow?: ConversationReservationFlow;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
  requiresManualReview?: boolean;
  mode: ConversationMode;
  humanRequested: boolean;
  assignedAgent?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastMessagePreview?: string;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  transport: MessageTransport;
  externalMessageSid?: string;
  body: string;
  rawPayload?: unknown;
  createdAt: string;
}

export interface ConversationEvent {
  id: string;
  conversationId: string;
  eventType: string;
  type?: string;
  label?: string;
  payload?: unknown;
  createdAt: string;
  at?: string;
}

export interface ConversationRecord extends Conversation {
  messages: Message[];
  events: ConversationEvent[];
}

export interface ConversationSnapshot {
  conversations: ConversationRecord[];
  updatedAt: string;
  suppressDemoSeed?: boolean;
  resetAt?: string;
}

export interface ConversationListFilters {
  query?: string;
  search?: string;
  status?: string;
  channel?: string;
  unreadOnly?: boolean;
  limit?: number;
  mode?: "all" | ConversationMode | "pending" | "read" | "archived";
}

export interface ConversationStats {
  total: number;
  unread: number;
  pending: number;
  human: number;
  read: number;
  archived: number;
}

export interface ConversationDashboard {
  conversations: ConversationRecord[];
  stats: ConversationStats;
}
