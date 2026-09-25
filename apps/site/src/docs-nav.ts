// SPDX-License-Identifier: AGPL-3.0-only
// Which files in the repository's docs/ are published on the site, in the docs navigation order.
// Each slug is a docs/<slug>.md file; its first heading is the page title.

export const docsNav = [
  {
    title: "Self-hosting",
    id: "self-hosting",
    items: [
      { slug: "deploy-cloudflare", label: "Deploy to Cloudflare" },
      { slug: "observability", label: "Observability" },
    ],
  },
  {
    title: "Reference",
    id: "reference",
    items: [{ slug: "annotation-format", label: "Annotation format" }],
  },
  {
    title: "Privacy",
    id: "privacy",
    items: [
      { slug: "privacy-external-resources", label: "External resources" },
      { slug: "privacy-trial-ledger", label: "Trial ledger" },
    ],
  },
] as const;

export const docPages = docsNav.flatMap((group) => group.items.map((item) => ({ ...item, group: group.title })));
export const publishedDocs: ReadonlySet<string> = new Set(docPages.map((p) => p.slug));
