import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ACTIVE_CHAT_PROJECT_SELECTION_STORAGE_KEY,
  ACTIVE_CHAT_WINDOW_OPTIONS,
  ACTIVE_CHAT_WINDOW_STORAGE_KEY,
  DEFAULT_ACTIVE_CHAT_WINDOW_HOURS,
  CHAT_PROJECT_COLORS,
  CHAT_PROJECT_STATE_STORAGE_KEY,
  emptyChatProjectState,
  loadActiveChatProjectSelection,
  loadActiveChatWindowHours,
  loadChatProjectState,
  moveChatProject,
  moveChatProjectTo,
  parseActiveChatWindowHours,
  parseChatProjectState,
  saveActiveChatProjectSelection,
  saveActiveChatWindowHours,
  saveChatProjectState,
} = await jiti.import("./chat-project-state.ts");

test("chat project state defaults safely for absent, malformed, and unsupported data", () => {
  const empty = emptyChatProjectState();
  assert.deepEqual(parseChatProjectState(null), empty);
  assert.deepEqual(parseChatProjectState("not json"), empty);
  assert.deepEqual(parseChatProjectState(JSON.stringify({ version: 2, projects: [] })), empty);
  assert.deepEqual(parseChatProjectState(JSON.stringify({
    version: 1,
    projects: [{ id: "duplicate", name: "One", color: "#2563eb" }, { id: "duplicate", name: "Two", color: "#7c3aed" }],
    assignments: {},
    pinnedSessionIds: [],
    archivedSessionIds: [],
  })), empty);
});

test("chat project state round-trips projects, ordering, assignments, pins, and archives", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = {
    projects: [
      { id: "research", name: " Research ", color: CHAT_PROJECT_COLORS[0] },
      { id: "shipping", name: "Shipping", color: CHAT_PROJECT_COLORS[1] },
    ],
    assignments: { "chat-1": "shipping", "chat-orphan": "deleted" },
    pinnedSessionIds: ["chat-1", "chat-1"],
    archivedSessionIds: ["chat-2"],
  };

  assert.equal(saveChatProjectState(state, storage), true);
  assert.ok(values.has(CHAT_PROJECT_STATE_STORAGE_KEY));
  assert.deepEqual(loadChatProjectState(storage), {
    version: 1,
    projects: [
      { id: "research", name: "Research", color: CHAT_PROJECT_COLORS[0] },
      { id: "shipping", name: "Shipping", color: CHAT_PROJECT_COLORS[1] },
    ],
    assignments: { "chat-1": "shipping" },
    pinnedSessionIds: ["chat-1"],
    archivedSessionIds: ["chat-2"],
  });
});

test("active chat window defaults, validates, and persists", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(DEFAULT_ACTIVE_CHAT_WINDOW_HOURS, 24);
  assert.ok(ACTIVE_CHAT_WINDOW_OPTIONS.includes(24));
  assert.equal(parseActiveChatWindowHours("24"), 24);
  assert.equal(parseActiveChatWindowHours("not-a-number"), 24);
  assert.equal(parseActiveChatWindowHours(25), 24);
  assert.equal(saveActiveChatWindowHours(168, storage), true);
  assert.equal(values.get(ACTIVE_CHAT_WINDOW_STORAGE_KEY), "168");
  assert.equal(loadActiveChatWindowHours(storage), 168);
  assert.equal(loadActiveChatProjectSelection(storage), false);
  assert.equal(saveActiveChatProjectSelection(true, storage), true);
  assert.equal(values.get(ACTIVE_CHAT_PROJECT_SELECTION_STORAGE_KEY), "1");
  assert.equal(loadActiveChatProjectSelection(storage), true);
  assert.equal(saveActiveChatProjectSelection(false, storage), true);
  assert.equal(loadActiveChatProjectSelection(storage), false);
});

test("storage failures are contained and project ordering moves only within bounds", () => {
  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  assert.deepEqual(loadChatProjectState(blocked), emptyChatProjectState());
  assert.equal(saveChatProjectState(emptyChatProjectState(), blocked), false);

  const projects = [
    { id: "one", name: "One", color: CHAT_PROJECT_COLORS[0] },
    { id: "two", name: "Two", color: CHAT_PROJECT_COLORS[1] },
    { id: "three", name: "Three", color: CHAT_PROJECT_COLORS[2] },
  ];
  assert.deepEqual(moveChatProject(projects, "two", -1).map(({ id }) => id), ["two", "one", "three"]);
  assert.deepEqual(moveChatProject(projects, "two", 1).map(({ id }) => id), ["one", "three", "two"]);
  assert.deepEqual(moveChatProject(projects, "one", -1), projects);
  assert.deepEqual(moveChatProjectTo(projects, "one", "three").map(({ id }) => id), ["two", "three", "one"]);
  assert.deepEqual(moveChatProjectTo(projects, "three", "one").map(({ id }) => id), ["three", "one", "two"]);
});
