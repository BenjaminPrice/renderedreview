// SPDX-License-Identifier: AGPL-3.0-only
// Nitro plugin: runs when the Node server boots, before it serves traffic
// (the app itself loads lazily on the first request).
import { ConfigError, redactConfig } from "@rendered-review/runtime";
import { loadNodeConfig } from "./config";

export default function validateConfig() {
  try {
    console.log(`Rendered Review config: ${redactConfig(loadNodeConfig())}`);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
