import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const rootDir = process.cwd();
const workerScript = join(rootDir, "bin", "pi-web-agent-worker.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sseBuffers = new WeakMap();

async function readDescriptor(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function startWorker(root, idleExitMs = 5000, sessionIdleMs = 600_000) {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return spawn(process.execPath, [workerScript], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_AGENT_WORKER_DESCRIPTOR: join(root, "worker.json"),
      PI_WEB_PACKAGE_DIR: rootDir,
      PI_WEB_WORKER_IDLE_EXIT_MS: String(idleExitMs),
      PI_WEB_IDLE_TIMEOUT_MS: String(sessionIdleMs),
    },
  });
}

async function workerRequest(descriptor, path, init = {}) {
  return fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "X-Pi-Web-Worker-Token": descriptor.token,
    },
  });
}

async function stopWorker(descriptor) {
  await workerRequest(descriptor, "/shutdown", { method: "POST" }).catch(() => {});
}

async function nextSseEvent(reader, timeoutMs = 5000) {
  const decoder = new TextDecoder();
  let buffer = sseBuffers.get(reader) ?? "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const idLine = block.split("\n").find((line) => line.startsWith("id: "));
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      sseBuffers.set(reader, buffer);
      return {
        id: idLine ? Number(idLine.slice(4)) : 0,
        data: JSON.parse(dataLine.slice(6)),
      };
    }
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ timeout: true })),
    ]);
    if (result.timeout) throw new Error("Timed out waiting for SSE event");
    if (result.done) throw new Error("SSE stream ended before the expected event");
    buffer += decoder.decode(result.value, { stream: true });
  }
  throw new Error("Timed out waiting for SSE event");
}

test("worker keeps the live session across independent web-process clients and replays SSE events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-worker-runtime-"));
  const worker = startWorker(root);
  let descriptor;
  t.after(async () => {
    if (descriptor) await stopWorker(descriptor);
    worker.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  descriptor = await readDescriptor(join(root, "worker.json"));
  const health = await workerRequest(descriptor, "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).pid, descriptor.pid);

  const project = join(root, "project");
  const created = await workerRequest(descriptor, "/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project, type: "ensure_session" }),
  });
  assert.equal(created.status, 200);
  const { sessionId } = await created.json();

  const probe = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fetch("http://127.0.0.1:" + d.port + "/session/" + encodeURIComponent(process.argv[2]) + "/snapshot", {
      headers: { "X-Pi-Web-Worker-Token": d.token }
    }).then(async (r) => { if (!r.ok) process.exit(1); const s = await r.json(); console.log(JSON.stringify({ pid: d.pid, sessionId: s.sessionId })); });
  `, join(root, "worker.json"), sessionId], { stdio: ["ignore", "pipe", "pipe"] });
  const probeOutput = await new Promise((resolve, reject) => {
    let output = "";
    probe.stdout.on("data", (chunk) => { output += chunk; });
    probe.once("error", reject);
    probe.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`probe exited ${code}`)));
  });
  assert.deepEqual(JSON.parse(probeOutput), { pid: descriptor.pid, sessionId });

  const firstStream = await workerRequest(descriptor, `/session/${encodeURIComponent(sessionId)}/events`);
  assert.equal(firstStream.status, 200);
  const firstReader = firstStream.body.getReader();
  t.after(() => firstReader.cancel().catch(() => {}));
  assert.equal((await nextSseEvent(firstReader)).data.type, "connected");

  const command = workerRequest(descriptor, `/session/${encodeURIComponent(sessionId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "bash", command: "printf worker-replay", excludeFromContext: false }),
  });
  const firstEvent = await nextSseEvent(firstReader);
  assert.ok(firstEvent.id > 0);
  await command;
  await firstReader.cancel();

  const secondCommand = workerRequest(descriptor, `/session/${encodeURIComponent(sessionId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "bash", command: "printf worker-replay-again", excludeFromContext: false }),
  });
  const secondResponse = await secondCommand;
  assert.equal(secondResponse.status, 200, await secondResponse.text());

  const replay = await workerRequest(descriptor, `/session/${encodeURIComponent(sessionId)}/events?after=${firstEvent.id}`);
  assert.equal(replay.status, 200);
  const replayReader = replay.body.getReader();
  t.after(() => replayReader.cancel().catch(() => {}));
  assert.equal((await nextSseEvent(replayReader)).data.type, "connected");
  const replayedEvent = await nextSseEvent(replayReader);
  assert.ok(replayedEvent.id > firstEvent.id);
  await replayReader.cancel();
});

test("worker reports an unknown subagent as not found so the caller can fall back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-worker-subagent-"));
  const worker = startWorker(root);
  let descriptor;
  t.after(async () => {
    if (descriptor) await stopWorker(descriptor);
    worker.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  descriptor = await readDescriptor(join(root, "worker.json"));
  const id = "subagent-not-here";

  // GET already answered 404; POST must match, otherwise a subagent owned by
  // the web process surfaced as a 500 "Subagent is not running" and that
  // process never received the steer or abort.
  const read = await workerRequest(descriptor, `/subagent/${id}`);
  assert.equal(read.status, 404);

  for (const body of [{ action: "steer", message: "carry on" }, { action: "abort" }]) {
    const response = await workerRequest(descriptor, `/subagent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Subagent not found");
  }
});

test("worker exits after its live session becomes idle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-worker-idle-"));
  const worker = startWorker(root, 1_000, 1_000);
  const descriptorPath = join(root, "worker.json");
  t.after(async () => {
    worker.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  const descriptor = await readDescriptor(descriptorPath);
  const created = await workerRequest(descriptor, "/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: join(root, "project"), type: "ensure_session" }),
  });
  assert.equal(created.status, 200);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not exit after idle timeout")), 10000);
    worker.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await assert.rejects(readFile(descriptorPath));
});
