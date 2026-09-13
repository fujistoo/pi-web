#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createJiti } = require("jiti");

const jiti = createJiti(__filename, { interopDefault: true });
const worker = jiti(path.join(__dirname, "..", "lib", "agent-worker-server.ts"));

worker.startWorkerFromEnvironment().catch((error) => {
  console.error(`[pi-web] agent worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
