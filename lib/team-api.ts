import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";

export class TeamApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requireTeamCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
    throw new TeamApiError("cwd must be an absolute path", 400);
  }
  const cwd = resolve(value.trim());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new TeamApiError("Directory not found", 404);
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, roots)) throw new TeamApiError("Access denied", 403);
  return cwd;
}

export function teamError(error: unknown): Response {
  const status = error instanceof TeamApiError
    ? error.status
    : error instanceof SyntaxError
      ? 400
      : error instanceof Error && /not found/i.test(error.message)
        ? 404
        : error instanceof Error && /(invalid|required|must|may not|only|already|cannot|waiting)/i.test(error.message)
          ? 400
          : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}
