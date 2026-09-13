import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const PREVIEW_RUNTIME_DIR = ".pi/previews";
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PREVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PREVIEW_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.html$/;
const PREVIEW_FEATURES: Record<string, string> = {
  notification: "IN-APP-NOTIFICATIONS",
  "pixel-agents": "PI-PIXEL-AGENTS",
};

export interface PreviewDefinition {
  id: string;
  feature: string;
  fileName: string;
}

export type PreviewId = string;

export function getPreviewDefinition(id: string): PreviewDefinition | null {
  if (!PREVIEW_ID_PATTERN.test(id)) return null;
  return {
    id,
    feature: PREVIEW_FEATURES[id] ?? "LIVE-PREVIEW",
    fileName: `${id}.html`,
  };
}

export interface PreviewArtifactPaths {
  directory: string;
  filePath: string;
}

export function getPreviewArtifactPaths(cwd: string, id: PreviewId): PreviewArtifactPaths {
  const definition = getPreviewDefinition(id);
  if (!definition) throw new Error("Invalid preview id");
  const directory = resolve(cwd, PREVIEW_RUNTIME_DIR);
  return {
    directory,
    filePath: join(directory, definition.fileName),
  };
}

export class PreviewArtifactTooLargeError extends Error {}
export class PreviewArtifactUnsafeError extends Error {}

function removeIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function statIfPresent(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertSafePreviewHtml(html: string): void {
  if (/<\/?(?:script|iframe|object|embed)\b|javascript\s*:|\son[a-z0-9_-]+\s*=/i.test(html)) {
    throw new PreviewArtifactUnsafeError("Preview artifacts may contain HTML and CSS only");
  }
}

export type PreviewReadResult =
  | { kind: "available"; html: string; source: "runtime"; feature: string }
  | { kind: "missing"; feature: string };

export function garbageCollectPreviewArtifacts(cwd: string): void {
  const directory = resolve(cwd, PREVIEW_RUNTIME_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const now = Date.now();
  for (const name of names) {
    const legacyArchive = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.html\.archived$/.test(name);
    if (legacyArchive) {
      removeIfPresent(join(directory, name));
      continue;
    }
    if (!PREVIEW_FILE_PATTERN.test(name)) continue;
    const filePath = join(directory, name);
    const fileStat = statIfPresent(filePath);
    if (fileStat && fileStat.isFile() && now - Number(fileStat.mtimeMs) > PREVIEW_TTL_MS) {
      removeIfPresent(filePath);
    }
  }
}

export function readPreviewArtifact(cwd: string | undefined, id: PreviewId): PreviewReadResult {
  const definition = getPreviewDefinition(id);
  if (!definition) throw new Error("Invalid preview id");
  if (!cwd) return { kind: "missing", feature: definition.feature };

  garbageCollectPreviewArtifacts(cwd);
  const paths = getPreviewArtifactPaths(cwd, id);
  const fileStat = statIfPresent(paths.filePath);

  if (!fileStat) return { kind: "missing", feature: definition.feature };
  if (Number(fileStat.size) > PREVIEW_MAX_BYTES) {
    throw new PreviewArtifactTooLargeError(`Preview artifacts must be ${PREVIEW_MAX_BYTES} bytes or smaller`);
  }

  const html = readFileSync(paths.filePath, "utf8");
  assertSafePreviewHtml(html);
  return { kind: "available", html, source: "runtime", feature: definition.feature };
}

export function deletePreviewArtifact(cwd: string, id: PreviewId): void {
  const definition = getPreviewDefinition(id);
  if (!definition) throw new Error("Invalid preview id");
  const paths = getPreviewArtifactPaths(cwd, id);
  removeIfPresent(paths.filePath);
  removeIfPresent(join(paths.directory, `.${definition.fileName}.archived`));
}
