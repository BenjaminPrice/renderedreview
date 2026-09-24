// SPDX-License-Identifier: AGPL-3.0-only
export { MAX_CONTEXT_LENGTH, validateAnnotation } from "./annotation.js";
export type { AnnotationSelector, RenderedReviewAnnotationV1, ValidationResult } from "./annotation.js";
export {
  composeCommentBody,
  composeExtendedSuggestionBody,
  composeSuggestionBody,
  permalink,
  stripRedundantContext,
} from "./body.js";
export type { CommentLocation } from "./body.js";
export { encodeAnnotation, extractAnnotation, MAX_DECODED_BYTES, MAX_ENCODED_LENGTH } from "./envelope.js";
export type { ExtractResult } from "./envelope.js";
export { verifyContent } from "./verify.js";
export type { ContentCheck } from "./verify.js";
