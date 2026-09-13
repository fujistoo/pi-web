import { NextRequest, NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  deletePreviewArtifact,
  getPreviewArtifactPaths,
  getPreviewDefinition,
  readPreviewArtifact,
  PreviewArtifactTooLargeError,
  PreviewArtifactUnsafeError,
  type PreviewId,
} from "@/lib/preview-artifacts";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

function nearestExistingPath(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function resolveWorkspace(cwd: string | null, id: PreviewId): Promise<{ cwd: string; paths: ReturnType<typeof getPreviewArtifactPaths> } | null> {
  if (!cwd) return null;
  const roots = await getAllowedFileRoots();
  const resolvedCwd = resolve(cwd);
  try {
    if (!statSync(resolvedCwd).isDirectory() || !isExistingFilePathAllowed(resolvedCwd, roots)) return null;
  } catch {
    return null;
  }

  const paths = getPreviewArtifactPaths(resolvedCwd, id);
  const existingParent = nearestExistingPath(paths.directory);
  if (!isFilePathAllowed(existingParent, roots) || !isExistingFilePathAllowed(existingParent, roots)) return null;
  if (existsSync(paths.filePath) && !isExistingFilePathAllowed(paths.filePath, roots)) return null;
  return { cwd: resolvedCwd, paths };
}

function htmlResponse(html: string, source: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Pi-Preview-Source": source,
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const definition = getPreviewDefinition(id);
  if (!definition) return NextResponse.json({ error: "Unknown preview" }, { status: 404 });

  const cwdParam = request.nextUrl.searchParams.get("cwd");
  const workspace = cwdParam ? await resolveWorkspace(cwdParam, id as PreviewId) : null;
  if (cwdParam && !workspace) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  try {
    const result = readPreviewArtifact(workspace?.cwd, id as PreviewId);
    if (result.kind !== "available") {
      return NextResponse.json({ error: "Preview unavailable", feature: result.feature }, { status: 404 });
    }
    return htmlResponse(result.html, result.source);
  } catch (error) {
    if (error instanceof PreviewArtifactTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof PreviewArtifactUnsafeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to read preview" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const definition = getPreviewDefinition(id);
  if (!definition) return NextResponse.json({ error: "Unknown preview" }, { status: 404 });

  const cwd = request.nextUrl.searchParams.get("cwd");
  const workspace = await resolveWorkspace(cwd, id as PreviewId);
  if (!workspace) return NextResponse.json({ error: "A valid project cwd is required" }, { status: 400 });

  try {
    deletePreviewArtifact(workspace.cwd, id as PreviewId);
    return NextResponse.json({ deleted: true, feature: definition.feature });
  } catch {
    return NextResponse.json({ error: "Unable to delete preview" }, { status: 500 });
  }
}
