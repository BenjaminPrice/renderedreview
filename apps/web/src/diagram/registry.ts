// SPDX-License-Identifier: AGPL-3.0-only
// The diagram formats this app renders. Each renderer module is imported the first time a
// document shows one of its fences; documents without diagrams never load renderer code.
import { createDiagramRegistry } from "@rendered-review/diagram-domain";
import { createContext } from "react";

export const diagramRegistry = createDiagramRegistry([
  {
    label: "Mermaid",
    fenceNames: ["mermaid"],
    // Diagrams render in the browser only; the SSR check keeps renderer code (and Mermaid's
    // megabytes) out of server bundles, including the Worker upload.
    load: () =>
      import.meta.env.SSR
        ? Promise.reject(new Error("Diagrams render in the browser"))
        : import("./mermaid").then((m) => m.loadMermaid()),
  },
]);

/** Tests substitute fake renderers here. */
export const DiagramRegistryContext = createContext(diagramRegistry);
