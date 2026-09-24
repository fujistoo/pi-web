import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider listing loads extensions so extension-registered providers appear", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf-8");

  // A bare `ModelRuntime.create()` classifies an extension-provided gateway as a
  // `models_json_*` custom provider, which `buildApiKeyProviderList` filters out —
  // so the provider worked in a session but never showed up in Settings → Models.
  assert.match(source, /createModelRuntimeWithExtensions\(\)/);
  assert.doesNotMatch(source, /await ModelRuntime\.create\(/);
  // Listing is capability-driven, never id-driven (#309).
  assert.match(source, /buildOAuthProviderList\(/);
  assert.match(source, /buildApiKeyProviderList\(/);
});
