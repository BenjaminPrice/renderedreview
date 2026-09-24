// SPDX-License-Identifier: AGPL-3.0-only
// Nitro plugin: runs when the Node server boots, before it serves traffic
// (the app itself loads lazily on the first request).
import { ConfigError, loadConfig, redactConfig } from "@rendered-review/runtime";

export default function validateConfig() {
  try {
    console.log(`Rendered Review config: ${redactConfig(loadConfig(process.env))}`);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
