import fs from "fs";
import os from "os";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access";
import { samePath } from "./paths";

export const PI_WEB_SEARCH_ROOT_ALIAS = "pi-web";

export interface FileSearchRoot {
  /** Stable, user-facing prefix for results outside the session cwd. */
  alias: string;
  path: string;
}

export class FileSearchRootError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function expandSearchRoot(value: string, piWebRoot: string, home: string): { alias: string; path: string } {
  if (value === PI_WEB_SEARCH_ROOT_ALIAS) {
    return { alias: PI_WEB_SEARCH_ROOT_ALIAS, path: piWebRoot };
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const suffix = value.slice(1).replace(/^[\\/]+/, "");
    const expanded = suffix ? path.join(home, suffix) : home;
    return { alias: path.basename(expanded) || "home", path: expanded };
  }
  if (path.isAbsolute(value) || isWindowsAbsolutePath(value)) {
    return { alias: path.basename(path.normalize(value)) || "root", path: value };
  }
  throw new FileSearchRootError(
    `searchRoot must be "${PI_WEB_SEARCH_ROOT_ALIAS}", "~", a "~/..." path, or an absolute path`,
    400,
  );
}

/**
 * Resolve and authorize explicit roots for multi-root file search. This does
 * not add roots to the allow-list: aliases, home-relative paths, and absolute
 * paths all pass through the existing lexical and realpath authorization.
 */
export function resolveFileSearchRoots(
  values: string[],
  cwd: string,
  allowedRoots: Set<string>,
  options: { piWebRoot?: string; home?: string } = {},
): FileSearchRoot[] {
  const piWebRoot = options.piWebRoot ?? process.cwd();
  const home = options.home ?? os.homedir();
  const roots: FileSearchRoot[] = [];
  const usedAliases = new Set<string>();

  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) throw new FileSearchRootError("searchRoot must not be empty", 400);
    const resolved = expandSearchRoot(value, piWebRoot, home);
    const normalizedPath = path.normalize(resolved.path);
    if (samePath(normalizedPath, cwd) || roots.some((root) => samePath(root.path, normalizedPath))) continue;
    if (!isFilePathAllowed(normalizedPath, allowedRoots)) throw new FileSearchRootError("Access denied", 403);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(normalizedPath);
    } catch {
      throw new FileSearchRootError("Directory not found", 404);
    }
    if (!stat.isDirectory()) throw new FileSearchRootError("Not a directory", 400);
    if (!isExistingFilePathAllowed(normalizedPath, allowedRoots)) {
      throw new FileSearchRootError("Access denied", 403);
    }

    let alias = resolved.alias;
    for (let suffix = 2; usedAliases.has(alias); suffix++) alias = `${resolved.alias}-${suffix}`;
    usedAliases.add(alias);
    roots.push({ alias, path: normalizedPath });
  }
  return roots;
}
