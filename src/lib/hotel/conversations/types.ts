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
  petCount?: number;
  checkInDate?: string;
  checkInTime?: string;
  checkInSlot?: "morning" | "afternoon";
  checkOutDate?: string;
  checkOutTime?: string;
  checkOutSlot?: "morning" | "afternoon";
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

export interface PendingReservationProposal {
  proposalId: string;
  conversationId: string;
  phoneNormalized: string;
  clientStatus: ConversationClientStatus;
  clientName?: string;
  petName: string;
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
  clientWarnings?: string[];
  clientSource?: "google_sheets_client_directory";
  clientSheetName?: string;
  clientSheetRow?: number;
  pendingReservationProposal?: PendingReservationProposal;
  pendingReservationContext?: PendingReservationContext;
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
