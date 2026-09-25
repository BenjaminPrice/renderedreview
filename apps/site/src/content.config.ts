// SPDX-License-Identifier: AGPL-3.0-only
// The docs section publishes the repository's docs/*.md in place; nothing is copied into the site.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({ loader: glob({ pattern: "*.md", base: "../../docs" }) }),
};
