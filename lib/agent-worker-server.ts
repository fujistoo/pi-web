import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentEventStream } from "./agent-event-stream";
import {
  abortSubagent,
  destroyRpcSessionsForCwd,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSession,
  getRpcSessionCount,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
  getSubagentRun,
  hasBusyRpcSessionForCwd,
  setRpcSessionTools,
  shutdownRpcSessions,
  startRpcSession,
  steerSubagent,
} from "./rpc-manager";
import {
  AGENT_WORKER_DESCRIPTOR_FILE,
  AGENT_WORKER_PROTOCOL_VERSION,
  type AgentWorkerDescriptor,
} from "./agent-worker-protocol";
import { resolveSessionPath } from "./session-reader";
import { generateSessionTitle } from "./session-title";
import { renewSessionLivenessLeases } from "./session-liveness";

const DEFAULT_IDLE_EXIT_MS = 60_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

type WorkerOptions = {
  host?: string;
  port?: number;
  token?: string;
  descriptorPath?: string;
  idleExitMs?: number;
};

function readPositiveTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getDescriptorPath(options: WorkerOptions): string {
  return options.descriptorPath
    ?? process.env.PI_WEB_AGENT_WORKER_DESCRIPTOR
    ?? join(getAgentDir(), AGENT_WORKER_DESCRIPTOR_FILE);
}

function writeDescriptor(path: string, descriptor: AgentWorkerDescriptor): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function removeDescriptor(path: string): void {
  try {
    const descriptor = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentWorkerDescriptor>;
    if (descriptor.pid !== process.pid) return;
  } catch {
    return;
  }
  rmSync(path, { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireWorkerLock(descriptorPath: string): { fd: number; path: string } | null {
  const lockPath = `${descriptorPath}.lock`;
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`, "utf8");
    return { fd, path: lockPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid: number;
    try {
      pid = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(pid) || processIsAlive(pid)) return null;
    rmSync(lockPath, { force: true });
    return acquireWorkerLock(descriptorPath);
  }
}

function releaseWorkerLock(lock: { fd: number; path: string } | null): void {
  if (!lock) return;
  closeSync(lock.fd);
  rmSync(lock.path, { force: true });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string[] {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function requestUrl(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").toString();
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function resolveOrStartSession(sessionId: string) {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return existing;
  const sessionFile = await resolveSessionPath(sessionId);
  if (!sessionFile) throw new Error("Session not found");
  return (await startRpcSession(sessionId, sessionFile, undefined)).session;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

async function createNewSession(body: Record<string, unknown>) {
  const cwd = body.cwd;
  if (typeof cwd !== "string" || !cwd) throw new Error("cwd is required");
  if (!existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);

  const { cwd: _cwd, provider, modelId, toolNames, thinkingLevel, ...promptCommand } = body;
  void _cwd;
  if ((provider && !modelId) || (!provider && modelId)) {
    throw new Error("provider and modelId must be provided together");
  }
  const tempKey = `__new__${randomUUID()}`;
  const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
  const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
    ...(Array.isArray(toolNames) ? { toolNames: toolNames as string[] } : {}),
    ...(provider && modelId ? { initialModel: { provider: provider as string, modelId: modelId as string } } : {}),
    ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
  });
  const state = await session.send({ type: "get_state" }) as {
    model?: { id: string; provider: string };
    thinkingLevel?: string;
  };
  if (promptCommand.type !== "ensure_session") {
    await session.send(promptCommand);
  }
  return {
    sessionId: realSessionId,
    data: null,
    model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
    thinkingLevel: state.thinkingLevel,
  };
}

async function generateTitle(sessionId: string) {
  const session = await resolveOrStartSession(sessionId);
  await session.waitUntilReady();
  const result = await generateSessionTitle(session.inner as never);
  if (!session.isAlive()) throw new Error("The session was closed while its title was being generated. Please try again.");
  session.inner.setSessionName(result.title);
  return { title: result.title, usage: result.usage ?? null };
}

function sessionSnapshot(sessionId: string) {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) return null;
  const manager = session.inner.sessionManager;
  return {
    sessionId: session.inner.sessionId,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
    sessionName: manager.getSessionName(),
    header: manager.getHeader(),
    entries: manager.getEntries(),
    leafId: manager.getLeafId(),
    tree: manager.getTree(),
    running: session.isRunning(),
  };
}

function workerState(session: Awaited<ReturnType<typeof resolveOrStartSession>>) {
  return session.send({ type: "get_state" }).then((state) => ({
    running: session.isRunning(),
    state,
  }));
}

function createWebRequest(request: IncomingMessage, signal: AbortSignal): Request {
  return new Request(requestUrl(request), {
    method: "GET",
    headers: request.headers as Record<string, string>,
    signal,
  });
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  sessionPromise: ReturnType<typeof resolveOrStartSession>,
  openStreams: { value: number },
): Promise<void> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  openStreams.value += 1;

  try {
    const stream = createAgentEventStream(
      createWebRequest(request, abortController.signal),
      sessionId,
      sessionPromise,
    );
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (response.destroyed) break;
        response.write(Buffer.from(next.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    openStreams.value -= 1;
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

export async function startAgentWorkerServer(options: WorkerOptions = {}): Promise<void> {
  const descriptorPath = getDescriptorPath(options);
  mkdirSync(dirname(descriptorPath), { recursive: true, mode: 0o700 });
  const workerLock = acquireWorkerLock(descriptorPath);
  if (!workerLock) return;
  const token = options.token || process.env.PI_WEB_AGENT_WORKER_TOKEN || randomUUID();
  const idleExitMs = options.idleExitMs
    ?? readPositiveTimeout(process.env.PI_WEB_WORKER_IDLE_EXIT_MS, DEFAULT_IDLE_EXIT_MS);
  const openStreams = { value: 0 };
  let lastActivity = Date.now();
  let shuttingDown = false;
  let cleanedUp = false;
  const openResponses = new Set<ServerResponse>();
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removeDescriptor(descriptorPath);
    releaseWorkerLock(workerLock);
  };
  let stopWorker: (exitCode?: number) => Promise<void> = async () => {};

  const server = createServer(async (request, response) => {
    openResponses.add(response);
    response.once("close", () => openResponses.delete(response));

    try {
      if (request.headers["x-pi-web-worker-token"] !== token) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const parts = requestPath(request);
      if (request.method !== "GET" || (parts[0] === "session" && parts[2] === "events")) {
        lastActivity = Date.now();
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "new") {
        sendJson(response, 200, { success: true, ...await createNewSession(await readBody(request)) });
        return;
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
        sendJson(response, 200, {
          ok: true,
          version: AGENT_WORKER_PROTOCOL_VERSION,
          pid: process.pid,
          sessionCount: getRpcSessionCount(),
        });
        return;
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "sessions" && parts[1] === "running") {
        sendJson(response, 200, {
          runningSessionIds: getRunningRpcSessionIds(),
          completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
        });
        return;
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "sessions" && parts[1] === "infos") {
        sendJson(response, 200, {
          sessions: getRpcSessionInfos({ includeTransient: true }),
          runningSessionIds: getRunningRpcSessionIds(),
          completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
        });
        return;
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "shutdown") {
        sendJson(response, 200, { success: true });
        setImmediate(() => { void stopWorker(); });
        return;
      }
      if (parts.length === 2 && parts[0] === "cwd" && parts[1] === "status" && request.method === "GET") {
        const cwd = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("cwd");
        if (!cwd) throw new Error("cwd is required");
        sendJson(response, 200, { busy: hasBusyRpcSessionForCwd(cwd) });
        return;
      }
      if (parts.length === 2 && parts[0] === "cwd" && parts[1] === "shutdown" && request.method === "POST") {
        const body = await readBody(request);
        if (typeof body.cwd !== "string" || !body.cwd) throw new Error("cwd is required");
        sendJson(response, 200, { count: await destroyRpcSessionsForCwd(body.cwd) });
        return;
      }
      if (parts.length === 2 && parts[0] === "subagent") {
        const subagentId = parts[1];
        if (request.method === "GET") {
          const run = await getSubagentRun(subagentId);
          sendJson(response, run ? 200 : 404, run ? { run } : { error: "Subagent not found" });
          return;
        }
        if (request.method === "POST") {
          // A subagent this worker does not own must answer 404, exactly like
          // GET above, so the caller falls back to its own local registry.
          // Without this an unknown id surfaced as a 500 "Subagent is not
          // running" and the owning process never received the steer or abort.
          if (!await getSubagentRun(subagentId)) {
            sendJson(response, 404, { error: "Subagent not found" });
            return;
          }
          const body = await readBody(request);
          if (body.action === "steer") {
            if (typeof body.message !== "string" || !body.message.trim()) throw new Error("message required");
            await steerSubagent(subagentId, body.message);
          } else if (body.action === "abort") {
            await abortSubagent(subagentId);
          } else {
            throw new Error("action must be steer or abort");
          }
          sendJson(response, 200, { ok: true, run: await getSubagentRun(subagentId) });
          return;
        }
      }
      if (parts.length < 3 || parts[0] !== "session") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const sessionId = parts[1];
      if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
        await streamEvents(request, response, sessionId, resolveOrStartSession(sessionId), openStreams);
        return;
      }
      if (request.method === "GET" && parts[2] === "snapshot" && parts.length === 3) {
        const snapshot = sessionSnapshot(sessionId);
        if (!snapshot) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, snapshot);
        return;
      }
      if (request.method === "GET" && parts[2] === "state" && parts.length === 3) {
        const sessionFile = await resolveSessionPath(sessionId);
        if (!sessionFile && !getRpcSession(sessionId)?.isAlive()) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          sendJson(response, 200, { running: false });
          return;
        }
        sendJson(response, 200, await workerState(session));
        return;
      }
      if (request.method === "POST" && parts[2] === "lease" && parts.length === 3) {
        sendJson(response, 200, { success: true, renewed: renewSessionLivenessLeases(sessionId) });
        return;
      }
      if (request.method === "POST" && parts[2] === "command" && parts.length === 3) {
        const body = await readBody(request);
        const existing = getRpcSession(sessionId);
        if (body.type === "shutdown_session") {
          if (existing?.isAlive()) await existing.shutdown();
          sendJson(response, 200, { success: true, data: null });
          return;
        }
        if (body.type === "set_tools") {
          const filePath = existing?.sessionFile || await resolveSessionPath(sessionId) || undefined;
          if (!existing?.isAlive() && !filePath) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }
          const changed = await setRpcSessionTools(sessionId, filePath, body.toolNames as string[] | undefined);
          sendJson(response, 200, { success: true, data: { sessionId: changed.sessionId, recreated: changed.recreated } });
          return;
        }
        const session = existing?.isAlive() ? existing : await resolveOrStartSession(sessionId);
        if (body.type === "auto_name") {
          sendJson(response, 200, { success: true, data: await generateTitle(sessionId) });
          return;
        }
        sendJson(response, 200, { success: true, data: await session.send(body) });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof Error && error.message === "Session not found" ? 404 : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const host = options.host ?? process.env.PI_WEB_AGENT_WORKER_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PI_WEB_AGENT_WORKER_PORT ?? 0);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownRpcSessions().catch((error) => {
      console.error("[pi-web] agent worker shutdown failed:", error instanceof Error ? error.message : error);
    });
    for (const response of openResponses) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
    process.exitCode = exitCode;
  };
  stopWorker = shutdown;

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent worker did not bind to a TCP port");
  writeDescriptor(descriptorPath, {
    version: AGENT_WORKER_PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    token,
    startedAt: new Date().toISOString(),
  });

  const idleTimer = setInterval(() => {
    if (!shuttingDown && openStreams.value === 0 && getRpcSessionCount() === 0 && Date.now() - lastActivity >= idleExitMs) {
      void stopWorker();
    }
  }, Math.min(5_000, Math.max(100, idleExitMs)));
  idleTimer.unref();

  process.once("SIGINT", () => { void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });
  process.once("exit", cleanup);
}

export async function startWorkerFromEnvironment(): Promise<void> {
  await startAgentWorkerServer();
}
