import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { sanitizePixelToolInput, startPixelPiTelemetry } = await createJiti(import.meta.url).import("./pixel-agents-telemetry.ts");

test("Pixel telemetry keeps tool input bounded and non-sensitive", () => {
  assert.deepEqual(sanitizePixelToolInput({
    file_path: "/tmp/index.ts",
    run_in_background: true,
    query: "x".repeat(600),
    secret: "must not travel",
    nested: { value: true },
  }), {
    file_path: "/tmp/index.ts",
    run_in_background: true,
    query: "x".repeat(500),
  });
});

test("Pixel telemetry maps a child session lifecycle without blocking it", () => {
  const events = [];
  let listener;
  const session = {
    sessionId: "child-session",
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  const stop = startPixelPiTelemetry(session, {
    cwd: "/tmp/project",
    parentSessionId: "parent-session",
    agentName: "Smoke child",
  }, (...args) => events.push(args));

  listener({ type: "agent_start" });
  listener({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { file_path: "/tmp/project/README.md" },
  });
  listener({ type: "tool_execution_end", toolCallId: "tool-1" });
  listener({ type: "agent_settled" });
  stop("completed");
  stop("completed-again");

  assert.deepEqual(events, [
    ["child-session", "/tmp/project", "session_start", {
      reason: "startup",
      parent_session_id: "parent-session",
      agent_name: "Smoke child",
    }],
    ["child-session", "/tmp/project", "agent_start"],
    ["child-session", "/tmp/project", "tool_execution_start", {
      tool_call_id: "tool-1",
      tool_name: "read",
      tool_input: { file_path: "/tmp/project/README.md" },
    }],
    ["child-session", "/tmp/project", "tool_execution_end", { tool_call_id: "tool-1" }],
    ["child-session", "/tmp/project", "agent_settled"],
    ["child-session", "/tmp/project", "session_shutdown", { reason: "completed" }],
  ]);
  assert.equal(listener, undefined);
});
