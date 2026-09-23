import fs from "fs";
import path from "path";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

function uploadPathSegments(fileName: string): string[] | null {
  if (!fileName || fileName.includes("\0") || fileName.includes("\\")) return null;
  if (path.isAbsolute(fileName) || path.win32.isAbsolute(fileName)) return null;

  const segments = fileName.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function getUploadDestination(directory: string, fileName: string): string {
  const segments = uploadPathSegments(fileName);
  if (!segments) throw new Error(`Invalid upload path: ${fileName || "(empty)"}`);
  const destination = path.resolve(directory, ...segments);
  if (!isWithinDirectory(path.resolve(directory), destination)) {
    throw new Error(`Upload path escapes its destination: ${fileName}`);
  }
  return destination;
}

function getBlockingParent(directory: string, fileName: string): string | null {
  const segments = uploadPathSegments(fileName);
  if (!segments) return fileName;

  let current = path.resolve(directory);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return fileName;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!uploadPathSegments(fileName)) return `Invalid upload path: ${fileName || "(empty)"}`;
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = getUploadDestination(directory, fileName);
    if (getBlockingParent(directory, fileName)) {
      conflicts.push(fileName);
      nonReplaceable.push(fileName);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

export function ensureUploadParentDirectory(directory: string, fileName: string): string {
  getUploadDestination(directory, fileName);
  const realDirectory = fs.realpathSync(directory);
  const segments = uploadPathSegments(fileName)!;
  let current = realDirectory;

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Upload parent is not a directory: ${fileName}`);
    }
    const realParent = fs.realpathSync(current);
    if (!isWithinDirectory(realDirectory, realParent)) {
      throw new Error(`Upload parent escapes its destination: ${fileName}`);
    }
  }

  return path.join(realDirectory, ...segments);
}

export function writeUploadFile(destination: string, bytes: Buffer, overwrite: boolean): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;

  if (overwrite) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Cannot replace a directory or symbolic link");
    }
    descriptor = fs.openSync(destination, fs.constants.O_WRONLY | noFollow);
    if (!fs.fstatSync(descriptor).isFile()) {
      fs.closeSync(descriptor);
      throw new Error("Cannot replace a directory or symbolic link");
    }
    fs.ftruncateSync(descriptor, 0);
  } else {
    descriptor = fs.openSync(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o666);
  }

  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}
