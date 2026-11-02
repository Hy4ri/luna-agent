// Deterministic projection of base64 images to session-scoped HTTP URLs.
// Preserves original storage/model context; extracts images on the fly for UI transport.
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentEvent, SnapshotEvent } from "./session-feed-types.js";

export const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_IMAGE_MIMES);
const EQUALS = 61;
const withoutPadding = (value: string) => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === EQUALS) end--;
  return end;
};

/**
 * Standard-alphabet base64 with at most two final '=' and canonical trailing bits.
 * One native decode and encode replaces a full-string regex: the decoder drops or translates every
 * character outside the standard alphabet, so any such character changes the re-encoded text.
 * Session views validate every embedded image on every read, so this is a hot path.
 */
export function isValidBase64(value: string): boolean {
  const end = withoutPadding(value);
  if (end === 0 || value.length - end > 2 || value.length % 4 === 1) return false;
  const encoded = Buffer.from(value, "base64").toString("base64");
  const encodedEnd = withoutPadding(encoded);
  return encodedEnd === end && encoded.substring(0, encodedEnd) === value.substring(0, end);
}

/** Check if a MIME type is one of the supported raster image formats (case-insensitive). */
export function isSupportedImageMime(mime: unknown): mime is SupportedImageMime {
  return typeof mime === "string" && SUPPORTED_MIME_SET.has(mime.toLowerCase());
}

export interface ExtractedImageBlock {
  readonly mimeType: SupportedImageMime;
  readonly data: string;
}

type ImageCandidate = { type: "image"; mimeType: string; data: string };
/** Supported inline image fields, before the costly base64 check. */
function isImageCandidate(obj: unknown): obj is ImageCandidate {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;
  return rec.type === "image" && isSupportedImageMime(rec.mimeType) && typeof rec.data === "string" && !!rec.data &&
    !rec.data.startsWith("luna-upload:");
}

/** Check if a candidate object is a supported base64 image block (not a luna-upload ref). */
export function isBase64ImageBlock(obj: unknown): obj is ImageCandidate {
  return isImageCandidate(obj) && isValidBase64(obj.data);
}

// Committed entries are immutable and their IDs are never reused for other content, so every view
// of an entry would validate the same megabytes again. Remember each verdict by entry, block position
// and length. The length and edge guard recomputes when a caller passes other content under a reused ID.
const VALIDITY_LIMIT = 4096;
const validity = new Map<string, boolean>();
function validImage(entryId: unknown, position: number, data: string): boolean {
  if (typeof entryId !== "number") return isValidBase64(data);
  const key = `${entryId}:${position}:${data.length}:${data.slice(0, 24)}:${data.slice(-24)}`;
  const known = validity.get(key);
  if (known !== undefined) return known;
  const valid = isValidBase64(data);
  validity.set(key, valid);
  if (validity.size > VALIDITY_LIMIT) validity.delete(validity.keys().next().value!);
  return valid;
}

/**
 * Deterministically traverse any value and collect all supported base64 image blocks.
 * Traversal visits array elements in index order and object entries in key order (Object.keys).
 */
export function collectEntryImages(value: unknown): ExtractedImageBlock[] {
  const images: ExtractedImageBlock[] = [];
  const entryId = (value as { id?: unknown } | null)?.id;
  let candidates = 0;

  function walk(val: unknown): void {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        walk(val[i]);
      }
      return;
    }
    if (isImageCandidate(val) && validImage(entryId, candidates++, val.data)) {
      images.push({
        mimeType: val.mimeType.toLowerCase() as SupportedImageMime,
        data: val.data,
      });
      return;
    }
    const keys = Object.keys(val as Record<string, unknown>);
    for (const key of keys) {
      walk((val as Record<string, unknown>)[key]);
    }
  }

  walk(value);
  return images;
}

/** Retrieve the N-th image block from an entry record using the deterministic traversal. */
export function getImageBlockAt(entry: EntryRecord, index: number): ExtractedImageBlock | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const images = collectEntryImages(entry);
  return images[index];
}

/**
 * Return a projected copy of an entry where all base64 image blocks have:
 * `data: ""` and `url: "/v1/sessions/<viewSessionId>/entries/<entryId>/images/<index>"`
 * MIME type is canonicalized to lowercase.
 * Index is sequentially incremented with each encountered image block.
 * Never mutates original.
 */
export function projectEntryImages<T extends EntryRecord>(entry: T, viewSessionId: string | number): T {
  let counter = 0, candidates = 0;
  const sid = encodeURIComponent(String(viewSessionId));
  const eid = entry.id;

  function walk(val: unknown): unknown {
    if (!val || typeof val !== "object") return val;
    if (Array.isArray(val)) {
      let changed = false;
      const mapped = val.map(item => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? mapped : val;
    }
    if (isImageCandidate(val) && validImage(eid, candidates++, val.data)) {
      const idx = counter++;
      const canonicalMime = val.mimeType.toLowerCase() as SupportedImageMime;
      const projected = {
        ...val,
        mimeType: canonicalMime,
        data: "",
        url: `/v1/sessions/${sid}/entries/${eid}/images/${idx}`,
      };
      return projected;
    }
    let changed = false;
    const res: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>);
    for (const key of keys) {
      const orig = (val as Record<string, unknown>)[key];
      const next = walk(orig);
      if (next !== orig) changed = true;
      res[key] = next;
    }
    return changed ? res : val;
  }

  return walk(entry) as T;
}

/**
 * Project an SSE snapshot event:
 * - Projects `entries` array using `projectEntryImages` (each entry has its own id and index space).
 * - Live uncommitted tools, nestedTools, generation partials are NOT committed entries,
 *   so they retain inline base64 data to avoid invalid URLs.
 */
export function projectSnapshotImages(snapshot: SnapshotEvent, viewSessionId: string | number): SnapshotEvent {
  if (!snapshot || !Array.isArray(snapshot.entries)) return snapshot;
  const projectedEntries = snapshot.entries.map(e => projectEntryImages(e, viewSessionId));
  return {
    ...snapshot,
    entries: projectedEntries,
  };
}

/**
 * Project an AgentEvent:
 * - `entry_appended`: project `event.entry`
 * - `message_end`: project `event.entry`
 * - `tool_execution_end`: if `event.entry` is present, project it
 * - `snapshot`: project via `projectSnapshotImages`
 * - other events remain untouched
 */
export function projectAgentEvent(event: AgentEvent, viewSessionId: string | number): AgentEvent {
  if (!event || typeof event !== "object") return event;
  switch (event.type) {
    case "entry_appended":
      return {
        ...event,
        entry: projectEntryImages(event.entry, viewSessionId),
      };
    case "message_end":
      return {
        ...event,
        entry: projectEntryImages(event.entry, viewSessionId),
      };
    case "tool_execution_end":
      if (event.entry) {
        return {
          ...event,
          entry: projectEntryImages(event.entry, viewSessionId),
        };
      }
      return event;
    case "snapshot":
      return projectSnapshotImages(event, viewSessionId);
    default:
      return event;
  }
}
