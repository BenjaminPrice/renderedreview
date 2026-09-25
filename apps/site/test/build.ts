// SPDX-License-Identifier: AGPL-3.0-only
// Vitest global setup: the tests read the built site, so build it once first.
import { build } from "astro";

export default async function setup() {
  await build({ root: new URL("..", import.meta.url).pathname, logLevel: "warn" });
}
