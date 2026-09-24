import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  AGENT_WORKER_DESCRIPTOR_FILE,
  AGENT_WORKER_PROTOCOL_VERSION,
  type AgentWorkerDescriptor,
} from "./agent-worker-protocol";

const WORKER_START_TIMEOUT_MS = 10_000;
const WORKER_RETRY_DELAY_MS = 50;

export class AgentWorkerUnavailableError extends Error {
  constructor(message = "The agent worker is unavailable") {
    super(message);
    this.name = "AgentWorkerUnavailableError";
  }
}

let startPromise: Promise<AgentWorkerDescriptor> | null = null;

export function getAgentWorkerDescriptorPath(): string {
  return process.env.PI_WEB_AGENT_WORKER_DESCRIPTOR
    ?? join(getAgentDir(), AGENT_WORKER_DESCRIPTOR_FILE);
}

export function hasAgentWorkerDescriptor(): boolean {
  return readDescriptor() !== null;
}

function readDescriptor(): AgentWorkerDescriptor | null {
  try {
    const descriptor = JSON.parse(readFileSync(getAgentWorkerDescriptorPath(), "utf8")) as AgentWorkerDescriptor;
    if (
      descriptor.version !== AGENT_WORKER_PROTOCOL_VERSION
      || !Number.isInteger(descriptor.pid)
      || descriptor.pid <= 0
      || !Number.isInteger(descriptor.port)
      || descriptor.port <= 0
      || descriptor.port > 65535
      || typeof descriptor.token !== "string"
      || descriptor.token.length === 0
    ) return null;
    return descriptor;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forgetDescriptor(): void {
  const descriptor = readDescriptor();
  if (!descriptor || !processIsAlive(descriptor.pid)) {
    rmSync(getAgentWorkerDescriptorPath(), { force: true });
  }
}

async function fetchWorker(
  descriptor: AgentWorkerDescriptor,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Pi-Web-Worker-Token", descriptor.token);
  headers.set("Cache-Control", "no-store");
  return fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    ...init,
    headers,
  });
}

async function healthyDescriptor(): Promise<AgentWorkerDescriptor | null> {
  const descriptor = readDescriptor();
  if (!descriptor || !processIsAlive(descriptor.pid)) {
    forgetDescriptor();
    return null;
  }
  try {
    const response = await fetchWorker(descriptor, "/health", { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const health = await response.json() as { ok?: boolean; version?: number };
    return health.ok && health.version === AGENT_WORKER_PROTOCOL_VERSION ? descriptor : null;
  } catch {
    return null;
  }
}

function launchWorker(): void {
  const packageDir = process.env.PI_WEB_PACKAGE_DIR ?? resolve(process.cwd());
  const scriptPath = process.env.PI_WEB_AGENT_WORKER_SCRIPT
    ?? join(packageDir, "bin", "pi-web-agent-worker.js");
  const child = spawn(process.execPath, [scriptPath], {
    cwd: packageDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

async function waitForWorker(): Promise<AgentWorkerDescriptor> {
  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const descriptor = await healthyDescriptor();
    if (descriptor) return descriptor;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, WORKER_RETRY_DELAY_MS));
  }
  throw new AgentWorkerUnavailableError("Timed out starting the agent worker");
}

export async function ensureAgentWorker(): Promise<AgentWorkerDescriptor> {
  const existing = await healthyDescriptor();
  if (existing) return existing;
  if (!startPromise) {
    startPromise = (async () => {
      launchWorker();
      return waitForWorker();
    })().finally(() => {
      startPromise = null;
    });
  }
  return startPromise;
}

async function requestWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const descriptor = await ensureAgentWorker();
  try {
    return await fetchWorker(descriptor, path, init);
  } catch (error) {
    if (!processIsAlive(descriptor.pid)) forgetDescriptor();
    throw new AgentWorkerUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

function sessionPath(sessionId: string, suffix: "state" | "command" | "events" | "lease" | "snapshot"): string {
  return `/session/${encodeURIComponent(sessionId)}/${suffix}`;
}

export function createAgentWorkerSession(body: Record<string, unknown>): Promise<Response> {
  return requestWorker("/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getAgentWorkerState(sessionId: string): Promise<Response> {
  return requestWorker(sessionPath(sessionId, "state"));
}

export function getExistingAgentWorkerState(sessionId: string): Promise<Response | null> {
  return requestExistingWorker(sessionPath(sessionId, "state"));
}

export function sendAgentWorkerCommand(sessionId: string, command: Record<string, unknown>): Promise<Response> {
  return requestWorker(sessionPath(sessionId, "command"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function sendExistingAgentWorkerCommand(sessionId: string, command: Record<string, unknown>): Promise<Response | null> {
  return requestExistingWorker(sessionPath(sessionId, "command"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function connectAgentWorkerEvents(sessionId: string, request: Request): Promise<Response> {
  return requestWorker(`${sessionPath(sessionId, "events")}${new URL(request.url).search}`, {
    signal: request.signal,
    headers: request.headers,
  });
}

export function connectExistingAgentWorkerEvents(sessionId: string, request: Request): Promise<Response | null> {
  return requestExistingWorker(`${sessionPath(sessionId, "events")}${new URL(request.url).search}`, {
    signal: request.signal,
    headers: request.headers,
  });
}

export function renewAgentWorkerLease(sessionId: string): Promise<Response> {
  return requestWorker(sessionPath(sessionId, "lease"), { method: "POST" });
}

export function renewExistingAgentWorkerLease(sessionId: string): Promise<Response | null> {
  return requestExistingWorker(sessionPath(sessionId, "lease"), { method: "POST" });
}

export function getAgentWorkerSnapshot(sessionId: string): Promise<Response> {
  return requestWorker(sessionPath(sessionId, "snapshot"));
}

async function requestExistingWorker(path: string, init: RequestInit = {}): Promise<Response | null> {
  const descriptor = await healthyDescriptor();
  if (!descriptor) return null;
  try {
    return await fetchWorker(descriptor, path, init);
  } catch {
    return null;
  }
}

export async function getExistingAgentWorkerSnapshot(sessionId: string): Promise<Response | null> {
  return requestExistingWorker(sessionPath(sessionId, "snapshot"));
}

export function getAgentWorkerRunning(): Promise<Response> {
  return requestWorker("/sessions/running");
}

export function getExistingAgentWorkerRunning(): Promise<Response | null> {
  return requestExistingWorker("/sessions/running");
}

export function getAgentWorkerInfos(): Promise<Response> {
  return requestWorker("/sessions/infos");
}

export function getExistingAgentWorkerInfos(): Promise<Response | null> {
  return requestExistingWorker("/sessions/infos");
}

export function getAgentWorkerCwdStatus(cwd: string): Promise<Response> {
  return requestWorker(`/cwd/status?cwd=${encodeURIComponent(cwd)}`);
}

export function getExistingAgentWorkerCwdStatus(cwd: string): Promise<Response | null> {
  return requestExistingWorker(`/cwd/status?cwd=${encodeURIComponent(cwd)}`);
}

export function shutdownAgentWorkerSessionsForCwd(cwd: string): Promise<Response> {
  return requestWorker("/cwd/shutdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function shutdownExistingAgentWorkerSessionsForCwd(cwd: string): Promise<Response | null> {
  return requestExistingWorker("/cwd/shutdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function getAgentWorkerSubagent(subagentId: string): Promise<Response> {
  return requestWorker(`/subagent/${encodeURIComponent(subagentId)}`);
}

export function getExistingAgentWorkerSubagent(subagentId: string): Promise<Response | null> {
  return requestExistingWorker(`/subagent/${encodeURIComponent(subagentId)}`);
}

export function sendAgentWorkerSubagentCommand(subagentId: string, command: Record<string, unknown>): Promise<Response> {
  return requestWorker(`/subagent/${encodeURIComponent(subagentId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function sendExistingAgentWorkerSubagentCommand(subagentId: string, command: Record<string, unknown>): Promise<Response | null> {
  return requestExistingWorker(`/subagent/${encodeURIComponent(subagentId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export async function shutdownAgentWorker(): Promise<void> {
  const descriptor = await healthyDescriptor();
  if (!descriptor) return;
  try {
    await fetchWorker(descriptor, "/shutdown", { method: "POST" });
  } catch {
    // The worker may exit before the response reaches the caller.
  }
}
