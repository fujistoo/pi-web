import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("keeps process details collapsed until manually toggled", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(source, /function ProcessDetailsGroup\(\{ sessionId,/);
  assert.match(source, /setExpanded\(false\);\n  \}, \[sessionId\]\)/);
  assert.match(source, /onClick=\{\(\) => setExpanded\(\(v\) => !v\)\}/);
  assert.doesNotMatch(source, /defaultExpanded/);
  assert.doesNotMatch(source, /revealProcess/);
  assert.match(source, /key=\{`process-group-\$\{session\?\.id \?\? sessionIdRef\.current \?\? "new"\}-/);
  assert.match(source, /if \(live\) setExpanded\(false\)/);
  assert.match(source, /const isLiveTail = \(sessionRunning \|\| sessionBusy \|\| isCompacting \|\| streamState\.isStreaming\)/);
  assert.match(source, /activeTaskStartedAt\?: number/);
  assert.match(source, /function getProcessDurationMs\(/);
  assert.match(source, /chat\.totalDuration/);
  assert.match(source, /type ProcessStatus = "running" \| "completed" \| "failed"/);
  assert.match(source, /function ProcessStatusIcon\(\{ status \}: \{ status: ProcessStatus \}\)/);
  assert.match(source, /status=\{isLiveTail \? "running" : finalError \? "failed" : "completed"\}/);
  assert.match(
    source,
    /<ProcessDetailsGroup sessionId=\{session\?\.id \?\? sessionIdRef\.current \?\? "new"\}[\s\S]*?activeTaskStartedAt=\{isLiveTail \? sessionStats\?\.activeTaskStartedAt : undefined\}[\s\S]*?live=\{isLiveTail\}/,
  );
});
