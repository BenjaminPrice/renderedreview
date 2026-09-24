// SPDX-License-Identifier: AGPL-3.0-only
import { type RenderedReviewAnnotationV1, validateAnnotation } from "./annotation.js";

/** Longest Base64 payload accepted, in characters. */
export const MAX_ENCODED_LENGTH = 16384;
/** Longest decoded JSON accepted, in UTF-8 bytes (exactly what fits in `MAX_ENCODED_LENGTH`). */
export const MAX_DECODED_BYTES = (MAX_ENCODED_LENGTH / 4) * 3;

const OPEN = "<!-- rendered-review:v";
const CLOSE = " -->";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ExtractResult =
  | { status: "none" }
  | { status: "ok"; annotation: RenderedReviewAnnotationV1; markerRange: { start: number; end: number } }
  | { status: "damaged"; reason: string }
  | { status: "unsupported"; version: number };

/**
 * Serialize an annotation as `<!-- rendered-review:v1:<base64> -->`: compact UTF-8 JSON in
 * single-line standard Base64. Throws `TypeError` if the annotation fails the schema and
 * `RangeError` if it exceeds the size limit (usually a very long quote; the caller should ask for
 * a narrower selection, since the quote is never truncated).
 */
export function encodeAnnotation(annotation: RenderedReviewAnnotationV1): string {
  const valid = validateAnnotation(annotation);
  if (!valid.ok) throw new TypeError(`Invalid annotation: ${valid.reason}`);
  const bytes = new TextEncoder().encode(JSON.stringify(annotation));
  if (bytes.length > MAX_DECODED_BYTES)
    throw new RangeError(`Annotation is ${bytes.length} bytes; the limit is ${MAX_DECODED_BYTES}`);
  return `${OPEN}1:${btoa(String.fromCharCode(...bytes))}${CLOSE}`;
}

const damaged = (reason: string): ExtractResult => ({ status: "damaged", reason });

/**
 * Find and decode the last annotation marker in a comment body. Never throws.
 *
 * Only the exact envelope counts: `<!-- rendered-review:v<N>:` then the payload, one space and
 * `-->`. Text around the marker is ignored. Anything wrong inside the envelope (whitespace,
 * non-standard or oversized Base64, invalid UTF-8 or JSON, schema violation) is `damaged`; a
 * well-formed marker with a version other than 1 is `unsupported`.
 */
export function extractAnnotation(body: string): ExtractResult {
  try {
    const start = body.lastIndexOf(OPEN);
    if (start < 0) return { status: "none" };
    const close = body.indexOf("-->", start + OPEN.length);
    if (close < 0) return damaged("The marker is not closed");
    const end = close + 3;
    const inner = body.slice(start + OPEN.length, close);
    const version = /^([1-9]\d{0,8}):/.exec(inner);
    if (!version) return damaged("The marker version is malformed");
    if (version[1] !== "1") return { status: "unsupported", version: Number(version[1]) };
    if (!inner.endsWith(" ")) return damaged("The marker must end with a space before -->");
    const payload = inner.slice(version[0].length, -1);
    if (payload.length > MAX_ENCODED_LENGTH) return damaged("The metadata exceeds the size limit");
    if (payload === "" || !BASE64.test(payload)) return damaged("The metadata is not valid Base64");
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_DECODED_BYTES) return damaged("The metadata exceeds the size limit");
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return damaged("The metadata is not valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return damaged("The metadata is not valid JSON");
    }
    const valid = validateAnnotation(value);
    if (!valid.ok) return damaged(`The metadata does not match the schema: ${valid.reason}`);
    return { status: "ok", annotation: valid.annotation, markerRange: { start, end } };
  } catch {
    return damaged("The metadata could not be read");
  }
}
