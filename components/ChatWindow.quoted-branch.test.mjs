import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { branchInNewChat, createForkedBranchSession } from "../lib/branch-in-new-chat.ts";
import { buildQuotedSelection } from "../lib/quoted-selection.ts";

test("forks a branch through fork_branch and preserves selected text as the initial prompt", async () => {
  const commands = [];
  const pendingPrompts = [];
  const forkedSessions = [];
  const initialPrompt = buildQuotedSelection("selected passage", "About this passage:", "My question:");
  await branchInNewChat({
    async sendCommand(sourceSessionId, command) {
      commands.push({ sourceSessionId, command });
      return { newSessionId: "forked-session" };
    },
    sourceSessionId: "source-session",
    sourceEntryId: "assistant-entry",
    initialPrompt,
    setPendingPrompt(prompt) {
      pendingPrompts.push(prompt);
    },
    onSessionForked(newSessionId) {
      forkedSessions.push(newSessionId);
    },
    failureMessage: "Unable to create a branch from this message.",
  });

  assert.deepEqual(commands, [{
    sourceSessionId: "source-session",
    command: { type: "fork_branch", entryId: "assistant-entry" },
  }]);
  assert.deepEqual(pendingPrompts, [{ sessionId: "forked-session", text: initialPrompt }]);
  assert.deepEqual(forkedSessions, ["forked-session"]);
  assert.equal(initialPrompt, "About this passage:\n\n> selected passage\n\nMy question:");
});

test("plain assistant-message branches fork without adding an initial prompt", async () => {
  const pendingPrompts = [];
  const forkedSessions = [];
  await branchInNewChat({
    async sendCommand() {
      return { newSessionId: "plain-fork" };
    },
    sourceSessionId: "source-session",
    sourceEntryId: "assistant-entry",
    setPendingPrompt(prompt) {
      pendingPrompts.push(prompt);
    },
    onSessionForked(newSessionId) {
      forkedSessions.push(newSessionId);
    },
    failureMessage: "Unable to create a branch from this message.",
  });

  assert.deepEqual(pendingPrompts, []);
  assert.deepEqual(forkedSessions, ["plain-fork"]);
});

test("forked branch creation keeps quote error handling on missing session ids", async () => {
  await assert.rejects(
    createForkedBranchSession(
      async () => ({}),
      "source-session",
      "assistant-entry",
      "Unable to create a branch from this message.",
    ),
    /Unable to create a branch from this message\./,
  );
});

test("keeps the selection toolbar above the session sidebar", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  const toolbar = chatSource.match(/role=\{quoteInputOpen \? "dialog" : "toolbar"\}[\s\S]*?zIndex:\s*(\d+)/);
  const sidebar = shellSource.match(/id="session-sidebar"[\s\S]*?zIndex:\s*(\d+)/);

  assert.ok(toolbar, "expected quote toolbar z-index");
  assert.ok(sidebar, "expected session sidebar z-index");
  assert.ok(
    Number(toolbar[1]) > Number(sidebar[1]),
    `quote toolbar z-index ${toolbar[1]} should be above session sidebar z-index ${sidebar[1]}`,
  );
});
