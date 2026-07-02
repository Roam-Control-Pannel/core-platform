/**
 * Messaging — the shared vocabulary of chat message KINDS and their payloads.
 *
 * WHY IN CORE: a message's kind + payload shape must mean the same thing everywhere — the API that
 * writes it, and every surface that renders it (web now; native next). Putting the kinds and the
 * validation here (framework- and transport-agnostic, no zod — core takes no such dep) makes that
 * one source of truth: the API calls validateMessage() on write so a malformed payload never lands,
 * and each client mirrors these kinds to build/render them. Adding a kind is a change in ONE place.
 *
 * PAYLOAD IS A SNAPSHOT, not a live join. A shared card carries the name/title captured at send time
 * (venue_card {venueId,name}, plan_card {planId,title}, profile_card {profileId,name,handle}), so it
 * renders instantly with no per-message fetch and still reads correctly if the entity later changes;
 * the id lets the card link through to the live thing. `image` carries a storage path (+ dims/mime).
 * A text message has no payload (null); a rich message may carry an optional body as a caption.
 */

/** Every message kind. `text` is the default; the rest are the rich-kind seam. */
export const MESSAGE_KINDS = [
  "text",
  "venue_card",
  "plan_card",
  "profile_card",
  "image",
  "poll",
] as const;
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

export interface PollOption {
  id: string;
  text: string;
}
export interface PollPayload {
  question: string;
  options: PollOption[];
  /** true = each person may pick multiple options; false = one choice (switchable). */
  multi: boolean;
}

export type MessagePayload =
  | VenueCardPayload
  | PlanCardPayload
  | ProfileCardPayload
  | ImagePayload
  | PollPayload
  | null;

/** A validated, normalized message ready to persist. */
export interface ValidatedMessage {
  kind: MessageKind;
  /** Text body, or an optional caption for a rich card. Null when absent. */
  body: string | null;
  payload: MessagePayload;
}

export type MessageValidation =
  | { ok: true; message: ValidatedMessage }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX = 4000;
const NAME_MAX = 200;
const HANDLE_MAX = 60;

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Trim, and null out an empty string (so blank captions/names are absent, not ""). */
function cleanBody(v: unknown): string | null {
  const s = asString(v);
  if (s === null) return null;
  const t = s.trim().slice(0, BODY_MAX);
  return t.length > 0 ? t : null;
}

/**
 * Validate + normalize an inbound message (kind + body + payload) against its kind's contract.
 * Pure: no I/O. Returns the normalized message to persist, or a human-readable error. The API is
 * the enforcement point; clients may mirror the kinds but never need to duplicate this.
 */
export function validateMessage(input: {
  kind?: string | null;
  body?: unknown;
  payload?: unknown;
}): MessageValidation {
  const kind = (input.kind ?? "text") as MessageKind;
  if (!(MESSAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `Unknown message kind: ${String(input.kind)}` };
  }
  const body = cleanBody(input.body);

  if (kind === "text") {
    if (!body) return { ok: false, error: "A text message can't be empty." };
    return { ok: true, message: { kind, body, payload: null } };
  }

  const p = input.payload;
  if (typeof p !== "object" || p === null) {
    return { ok: false, error: "This message is missing its content." };
  }
  const obj = p as Record<string, unknown>;

  if (kind === "venue_card") {
    const venueId = asString(obj.venueId);
    const name = asString(obj.name);
    if (!venueId || !UUID.test(venueId)) return { ok: false, error: "Invalid venue reference." };
    if (!name || !name.trim()) return { ok: false, error: "Missing venue name." };
    return { ok: true, message: { kind, body, payload: { venueId, name: name.trim().slice(0, NAME_MAX) } } };
  }

  if (kind === "plan_card") {
    const planId = asString(obj.planId);
    const title = asString(obj.title);
    if (!planId || !UUID.test(planId)) return { ok: false, error: "Invalid plan reference." };
    if (!title || !title.trim()) return { ok: false, error: "Missing plan title." };
    return { ok: true, message: { kind, body, payload: { planId, title: title.trim().slice(0, NAME_MAX) } } };
  }

  if (kind === "profile_card") {
    const profileId = asString(obj.profileId);
    const name = asString(obj.name);
    const handle = asString(obj.handle);
    if (!profileId || !UUID.test(profileId)) return { ok: false, error: "Invalid profile reference." };
    if (!name || !name.trim()) return { ok: false, error: "Missing name." };
    return {
      ok: true,
      message: {
        kind,
        body,
        payload: {
          profileId,
          name: name.trim().slice(0, NAME_MAX),
          handle: handle && handle.trim() ? handle.trim().replace(/^@/, "").slice(0, HANDLE_MAX) : null,
        },
      },
    };
  }

  if (kind === "image") {
    const path = asString(obj.path);
    if (!path || !path.trim()) return { ok: false, error: "Missing image." };
    const width = typeof obj.width === "number" && Number.isFinite(obj.width) ? obj.width : null;
    const height = typeof obj.height === "number" && Number.isFinite(obj.height) ? obj.height : null;
    const mime = asString(obj.mime);
    return {
      ok: true,
      message: { kind, body, payload: { path: path.trim(), width, height, mime: mime && mime.trim() ? mime.trim() : null } },
    };
  }

  if (kind === "poll") {
    const question = asString(obj.question);
    if (!question || !question.trim()) return { ok: false, error: "Give your poll a question." };
    if (!Array.isArray(obj.options)) return { ok: false, error: "A poll needs options." };
    const options: PollOption[] = [];
    const seenIds = new Set<string>();
    for (const raw of obj.options as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const o = raw as Record<string, unknown>;
      const id = asString(o.id);
      const text = asString(o.text);
      if (!id || !id.trim() || !text || !text.trim()) continue; // skip malformed/blank options
      if (seenIds.has(id)) continue; // ids must be unique
      seenIds.add(id);
      options.push({ id: id.trim().slice(0, 64), text: text.trim().slice(0, NAME_MAX) });
      if (options.length >= 10) break; // cap at 10 options
    }
    if (options.length < 2) return { ok: false, error: "A poll needs at least two options." };
    return {
      ok: true,
      message: { kind, body, payload: { question: question.trim().slice(0, 300), options, multi: obj.multi === true } },
    };
  }

  return { ok: false, error: "Unsupported message kind." };
}
