import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./LivePreviewPanel.tsx", import.meta.url), "utf8");
const artifactsSource = await readFile(new URL("../lib/preview-artifacts.ts", import.meta.url), "utf8");

test("starts with no preview tab and opens only output-linked previews", () => {
  assert.match(shellSource, /const \[previewTabs, setPreviewTabs\] = useState<PreviewTab\[\]>\(\[\]\)/);
  assert.match(shellSource, /function previewIdFromFilePath/);
  assert.match(shellSource, /const handleOpenPreviewTab = useCallback/);
  assert.match(shellSource, /previewIdFromFilePath\(filePath\)/);
  assert.doesNotMatch(shellSource, /i18n\.addPreview|i18n\.noPreviews/);
  assert.doesNotMatch(shellSource, /useState<PreviewId>\("notification"\)/);
});

test("preview tabs delete their artifact and close the final preview surface", () => {
  assert.match(shellSource, /const handleClosePreviewTab = useCallback/);
  assert.match(shellSource, /setPreviewTabs\(remaining\)/);
  assert.doesNotMatch(shellSource, /setPreviewOpen\(false\)/);
  assert.match(shellSource, /setRightPanelOpen\(false\)/);
  assert.match(shellSource, /onClick=\{\(\) => handleClosePreviewTab\(key\)\}/);
  assert.match(shellSource, /method: "DELETE"/);
  assert.match(artifactsSource, /deletePreviewArtifact/);
});

test("does not serve a built-in preview fallback", () => {
  assert.doesNotMatch(artifactsSource, /defaultHtml/);
  assert.doesNotMatch(artifactsSource, /source: "default"/);
  assert.match(artifactsSource, /kind: "missing"/);
  assert.match(artifactsSource, /garbageCollectPreviewArtifacts/);
  assert.doesNotMatch(artifactsSource, /archivePreviewArtifact/);
  assert.match(panelSource, /unavailableLabel: string/);
  assert.doesNotMatch(panelSource, /archiveLabel|onArchived/);
});
