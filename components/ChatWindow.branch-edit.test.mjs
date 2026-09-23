// "Edit from here" rewinds the session tree immediately (pi semantics), so the
// click needs a way back: ChatWindow remembers the leaf it rewound from, and a
// strip above the composer offers Cancel. These assertions pin that wiring plus
// the composer rule that makes Cancel safe (behaviour checked directly).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { shouldClearRestoredEdit } = await jiti.import("./ChatInput.tsx");

test("edit from here captures the leaf it rewound from, without nesting", () => {
  const editSource = chatWindowSource.slice(
    chatWindowSource.indexOf("  const handleEditFromHere = useCallback"),
    chatWindowSource.indexOf("  const cancelBranchEdit = useCallback"),
  );
  const cancelSource = chatWindowSource.slice(
    chatWindowSource.indexOf("  const cancelBranchEdit = useCallback"),
    chatWindowSource.indexOf("  // A started run is what commits the branch"),
  );

  assert.match(chatWindowSource, /onNavigate=\{sessionBusy \? undefined : handleEditFromHere\}/);
  assert.match(editSource, /const previousLeafId = activeLeafId/);
  // Repeated clicks keep the original target so Cancel always returns to where
  // the user started editing, not one step back per click.
  assert.match(editSource, /setBranchEdit\(\(current\) => current \?\? \{ previousLeafId \}\)/);
  assert.match(cancelSource, /setBranchEdit\(null\)/);
  assert.match(cancelSource, /handleNavigate\(previousLeafId\)/);
  assert.match(chatWindowSource, /\{branchEdit && \(/);
  assert.match(chatWindowSource, /t\("i18n.editingFromHere"\)/);
  assert.match(chatWindowSource, /t\("i18n.cancel"\)/);
});

test("cancelling edit from here only clears text it restored itself", () => {
  assert.equal(shouldClearRestoredEdit("original prompt", "original prompt"), true);
  assert.equal(shouldClearRestoredEdit("  original prompt \n", "original prompt"), true);
  assert.equal(shouldClearRestoredEdit("original prompt plus my edits", "original prompt"), false);
  assert.equal(shouldClearRestoredEdit("", "original prompt"), false);
  assert.equal(shouldClearRestoredEdit("", ""), false);

  assert.match(chatWindowSource, /chatInputRef\?\.current\?\.clearIfValue\(editedTextRef\.current\)/);
  assert.match(chatInputSource, /clearIfValue\(text: string\) \{\s*if \(shouldClearRestoredEdit\(valueRef\.current, text\)\) clearInput\(\);/);
});
