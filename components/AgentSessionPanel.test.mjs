import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");

test("keeps the main session first and makes every agent session selectable", () => {
  const mainRow = source.indexOf("session={rootSession}");
  const subagentRows = source.indexOf("visibleSubagents.map");
  assert.ok(mainRow > 0);
  assert.ok(subagentRows > mainRow);
  assert.match(source, /onSelect=\{\(\) => onSelectSession\(rootSession\)\}/);
  assert.match(source, /onSelect=\{\(\) => onSelectSession\(session\)\}/);
  assert.match(source, /aria-selected=\{selected\}/);
  assert.match(source, /function HoverMarquee/);
  assert.match(source, /agent-title-marquee-track/);
});

test("sorts running subagents first and enables search only for larger families", () => {
  assert.match(source, /if \(aRunning !== bRunning\) return aRunning \? -1 : 1/);
  assert.match(source, /subagents\.length > 8/);
  assert.match(source, /relation\?\.description, relation\?\.profile, session\.name, session\.firstMessage/);
  assert.match(source, /flex: 1, minHeight: 0, overflowY: "auto"/);
});

test("fills the shared resource panel without dropdown chrome", () => {
  assert.match(source, /height: "100%"/);
  assert.match(source, /display: "flex"/);
  assert.doesNotMatch(source, /borderLeft: "1px solid var\(--border\)"/);
  assert.doesNotMatch(source, /borderRadius: "0 0 6px 6px"/);
  assert.doesNotMatch(source, /maxWidth: 680/);
});

test("keeps Workspace as a sibling resource view", () => {
  assert.doesNotMatch(source, /onOpenWorkspace/);
  assert.doesNotMatch(source, /agents\.workspace/);
});

test("allows the panel to render without a root or spawned agents", () => {
  assert.match(source, /rootSession\?: SessionInfo/);
  assert.match(source, /rootSession && \(/);
  assert.match(source, /subagents\.length === 0 \? "agentSwitcher\.noAgents" : "agentSwitcher\.noMatches"/);
});

test("shows persisted completion states while live running state takes precedence", () => {
  assert.match(source, /const status: SubagentSessionStatus = running \? "running" : relation\?\.status \?\? "completed"/);
  assert.match(source, /t\(`agentSwitcher\.status\.\$\{status\}`\)/);
  assert.match(source, /status === "failed"/);
  assert.match(source, /status === "aborted" \|\| status === "interrupted"/);
});
