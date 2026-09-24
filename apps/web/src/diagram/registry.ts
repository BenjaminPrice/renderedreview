// SPDX-License-Identifier: AGPL-3.0-only
// The diagram formats this app renders. Each renderer module is imported the first time a
// document shows one of its fences; documents without diagrams never load renderer code.
import { createDiagramRegistry } from "@rendered-review/diagram-domain";
import { createContext } from "react";

export const diagramRegistry = createDiagramRegistry([
  { label: "Mermaid", fenceNames: ["mermaid"], load: () => import("./mermaid").then((m) => m.loadMermaid()) },
]);

/** Tests substitute fake renderers here. */
export const DiagramRegistryContext = createContext(diagramRegistry);
