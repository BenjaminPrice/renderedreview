// SPDX-License-Identifier: AGPL-3.0-only
// Guards the deploy config: static assets only, the built 404 page, and the custom domain on production alone.
import { unstable_readConfig } from "wrangler";
import { expect, it } from "vitest";

const read = (env?: string) =>
  unstable_readConfig({ config: new URL("../wrangler.jsonc", import.meta.url).pathname, env });

it("serves the Astro build as static assets with no Worker script, and the built 404 page", () => {
  for (const env of [undefined, "preview", "production"]) {
    const config = read(env);
    expect(config.main).toBeUndefined();
    expect(config.assets?.directory).toMatch(/dist$/);
    expect(config.assets?.not_found_handling).toBe("404-page");
  }
});

it("binds renderedreview.com in production only", () => {
  expect(read("production").routes).toEqual([{ pattern: "renderedreview.com", custom_domain: true }]);
  expect(read("preview").routes).toBeUndefined();
  expect(read("preview").workers_dev).toBe(true);
});
