import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PREVIEW_TTL_MS,
  deletePreviewArtifact,
  getPreviewArtifactPaths,
  getPreviewDefinition,
  readPreviewArtifact,
} = await jiti.import("./preview-artifacts.ts");

function withTempCwd(callback) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-preview-"));
  try {
    return callback(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("returns no preview when no runtime artifact exists", () => {
  const result = readPreviewArtifact(undefined, "notification");
  assert.equal(result.kind, "missing");
  assert.equal(result.feature, "IN-APP-NOTIFICATIONS");
});

test("accepts arbitrary output-linked preview filenames", () => {
  const definition = getPreviewDefinition("something");
  assert.deepEqual(definition, {
    id: "something",
    feature: "LIVE-PREVIEW",
    fileName: "something.html",
  });
  assert.equal(getPreviewDefinition("../secret"), null);
  assert.equal(getPreviewDefinition("something.html/.."), null);
});

test("deletes a runtime preview without leaving an archive marker", () => {
  withTempCwd((cwd) => {
    const paths = getPreviewArtifactPaths(cwd, "notification");
    const legacyArchivePath = join(paths.directory, ".notification.html.archived");
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.filePath, "<style>body { color: red; }</style>");
    writeFileSync(legacyArchivePath, "legacy archive");

    deletePreviewArtifact(cwd, "notification");
    assert.equal(existsSync(paths.filePath), false);
    assert.equal(existsSync(legacyArchivePath), false);
    assert.equal(readPreviewArtifact(cwd, "notification").kind, "missing");
  });
});

test("garbage-collects stale runtime overrides without recreating a preview", () => {
  withTempCwd((cwd) => {
    const paths = getPreviewArtifactPaths(cwd, "notification");
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.filePath, "<style>body { color: red; }</style>");
    const stale = (Date.now() - PREVIEW_TTL_MS - 1_000) / 1000;
    utimesSync(paths.filePath, stale, stale);
    const legacyArchivePath = join(paths.directory, ".notification.html.archived");
    writeFileSync(legacyArchivePath, "legacy archive");

    const result = readPreviewArtifact(cwd, "notification");
    assert.equal(result.kind, "missing");
    assert.equal(existsSync(paths.filePath), false);
    assert.equal(existsSync(legacyArchivePath), false);
  });
});

test("rejects executable markup in runtime overrides", () => {
  withTempCwd((cwd) => {
    const paths = getPreviewArtifactPaths(cwd, "notification");
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.filePath, "<script>alert('nope')</script>");
    assert.throws(() => readPreviewArtifact(cwd, "notification"), /HTML and CSS only/);
  });
});
