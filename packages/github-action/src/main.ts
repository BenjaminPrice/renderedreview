// SPDX-License-Identifier: AGPL-3.0-only
// Action entry point, bundled into dist/index.js.
import { readFileSync } from "node:fs";
import { run } from "./index";

const escape = (message: string) => message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  console.log(await run({ env: process.env, event, fetch }));
} catch (error) {
  const message = escape(`Rendered Review link: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env["INPUT_FAIL-ON-ERROR"]?.trim() === "true") {
    console.log(`::error::${message}`);
    process.exitCode = 1;
  } else {
    console.log(`::warning::${message}`);
  }
}
