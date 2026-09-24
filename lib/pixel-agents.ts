import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PIXEL_AGENTS_DIR = ".pixel-agents";
const REGISTRY_DIR = "servers";

type ServerRecord = {
  port: number;
  pid: number;
  token: string;
  startedAt?: number;
  servesSpa?: boolean;
  providerId?: string;
};

export type PixelAgentsOffice = {
  available: true;
  url: string;
  providerId: "pi";
} | {
  available: false;
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPiStandaloneServer(value: unknown): value is ServerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ServerRecord>;
  return Number.isSafeInteger(record.port) && record.port! > 0 && record.port! <= 65535
    && Number.isSafeInteger(record.pid) && record.pid! > 0
    && typeof record.token === "string" && record.token.length > 0
    && record.servesSpa === true
    && record.providerId === "pi";
}

export function findPiStandaloneServer(home = homedir()): ServerRecord | null {
  const registry = join(home, PIXEL_AGENTS_DIR, REGISTRY_DIR);
  let files: string[];
  try {
    files = readdirSync(registry).filter((file) => file.endsWith(".json"));
  } catch {
    return null;
  }

  return files
    .map((file) => readJson(join(registry, file)))
    .filter(isPiStandaloneServer)
    .filter((record) => isLive(record.pid))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;
}

export function getPixelAgentsOffice(home = homedir(), sessionId?: string): PixelAgentsOffice {
  const server = findPiStandaloneServer(home);
  if (!server) return { available: false };
  const scope = sessionId
    ? `&sessionId=${encodeURIComponent(sessionId)}&scope=children`
    : "";
  return {
    available: true,
    providerId: "pi",
    url: `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(server.token)}&readonly=1${scope}`,
  };
}
