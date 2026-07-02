/**
 * Chat message kinds — WEB MIRROR of @roam/core/messaging.
 *
 * The web bundle cannot import @roam/core (ARCHITECTURE.md: the web shell talks to the domain only
 * through the api layer). So the kind constants + payload shapes are mirrored here for the client to
 * BUILD payloads (share menu) and RENDER them (message cards). The server still owns validation —
 * core.validateMessage runs on every send — so this mirror never needs the validation logic, only
 * the vocabulary. Keep in sync with packages/core/src/messaging/index.ts.
 */

export const MESSAGE_KINDS = ["text", "venue_card", "plan_card", "profile_card", "image"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface VenueCardPayload {
  venueId: string;
  name: string;
}
export interface PlanCardPayload {
  planId: string;
  title: string;
}
export interface ProfileCardPayload {
  profileId: string;
  name: string;
  handle: string | null;
}
export interface ImagePayload {
  path: string;
  width: number | null;
  height: number | null;
  mime: string | null;
}
