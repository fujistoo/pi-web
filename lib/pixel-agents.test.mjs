import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { findPiStandaloneServer, getPixelAgentsOffice } = await import("./pixel-agents.ts");

test("findPiStandaloneServer selects the newest live Pi standalone server", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-pixel-agents-"));
  const registry = join(home, ".pixel-agents", "servers");
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "old.json"), JSON.stringify({
    pid: process.pid,
    port: 3101,
    token: "old",
    startedAt: 1,
    servesSpa: true,
    providerId: "pi",
  }));
  writeFileSync(join(registry, "new.json"), JSON.stringify({
    pid: process.pid,
    port: 3102,
    token: "new token",
    startedAt: 2,
    servesSpa: true,
    providerId: "pi",
  }));
  writeFileSync(join(registry, "claude.json"), JSON.stringify({
    pid: process.pid,
    port: 3103,
    token: "claude",
    startedAt: 3,
    servesSpa: true,
    providerId: "claude",
  }));
  writeFileSync(join(registry, "embedded.json"), JSON.stringify({
    pid: process.pid,
    port: 3104,
    token: "embedded",
    startedAt: 4,
    servesSpa: false,
    providerId: "pi",
  }));

  assert.deepEqual(findPiStandaloneServer(home), {
    pid: process.pid,
    port: 3102,
    token: "new token",
    startedAt: 2,
    servesSpa: true,
    providerId: "pi",
  });
  assert.deepEqual(getPixelAgentsOffice(home), {
    available: true,
    providerId: "pi",
    url: "http://127.0.0.1:3102/?token=new%20token&readonly=1",
  });
  assert.deepEqual(getPixelAgentsOffice(home, "root/session"), {
    available: true,
    providerId: "pi",
    url: "http://127.0.0.1:3102/?token=new%20token&readonly=1&sessionId=root%2Fsession&scope=children",
  });
});

test("getPixelAgentsOffice stays unavailable without a Pi server", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-pixel-agents-empty-"));
  assert.deepEqual(getPixelAgentsOffice(home), { available: false });
});
