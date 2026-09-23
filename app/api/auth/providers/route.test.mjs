import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider listing loads extensions so extension-registered providers appear", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf-8");

  // A bare `ModelRuntime.create()` classifies an extension-provided gateway as a
  // `models_json_*` custom provider, which `buildApiKeyProviderList` filters out —
  // so the provider worked in a session but never showed up in Settings → Models.
  assert.match(source, /createAgentSessionServices\(\{/);
  assert.doesNotMatch(source, /await ModelRuntime\.create\(/);
  // Home cwd: no project-local `.pi` resources are imported, so project trust is
  // not consulted on a listing request.
  assert.match(source, /cwd:\s*homedir\(\)/);
});
