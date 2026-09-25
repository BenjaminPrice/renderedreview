// SPDX-License-Identifier: AGPL-3.0-only
// Public, indexable pages only (not 404 or coming-soon pages). The site test checks it lists them all.
import { SITE_URL } from "../site";

export function GET() {
  const paths = ["/", "/pricing/"];
  const urls = paths.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`).join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { "content-type": "application/xml" } },
  );
}
