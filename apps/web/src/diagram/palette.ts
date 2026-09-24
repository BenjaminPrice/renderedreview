// SPDX-License-Identifier: AGPL-3.0-only
// Colours for renderers that draw their own defaults, matching the app's light and dark themes.
import type { DiagramTheme } from "@rendered-review/diagram-domain";

export const PALETTE: Record<DiagramTheme, { text: string; muted: string; line: string; accent: string }> = {
  light: { text: "#1f2328", muted: "#59636e", line: "#818b98", accent: "#0969da" },
  dark: { text: "#f0f6fc", muted: "#9198a1", line: "#6e7681", accent: "#4493f8" },
};
