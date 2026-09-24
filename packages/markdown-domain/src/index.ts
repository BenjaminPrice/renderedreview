// SPDX-License-Identifier: AGPL-3.0-only
export { normalizeText } from "./normalize.js";
export { blocksForLines, renderMarkdown } from "./render.js";
export type { RenderedMarkdown, RenderOptions, SourceNode, SourcePoint, SourceRange } from "./render.js";
export { githubContentOrigins } from "./resources.js";
export type { DocumentLocation, ResourceOptions } from "./resources.js";
export { rejectSelection, renderedText, selectionToSource, sourceToRendered } from "./selection.js";
export type { RenderedPoint, RenderedRun, SelectionRejection, SelectionResult, SourceSelection } from "./selection.js";
