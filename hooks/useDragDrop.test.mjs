import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./useDragDrop.ts");
}

function fileEntry(name, contents = name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success) {
      success(new File([contents], name, { type: "text/plain", lastModified: 123 }));
    },
  };
}

function directoryEntry(name, batches) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0;
      return {
        readEntries(success) {
          success(batches[index++] ?? []);
        },
      };
    },
  };
}

function transfer(items, files = []) {
  return { items, files };
}

test("falls back to the ordinary flat file list", async () => {
  const { collectDroppedFiles } = await loadSubject();
  const original = new File(["a"], "a.txt");
  const result = await collectDroppedFiles(transfer([{ getAsFile: () => original }], [original]));

  assert.deepEqual(result, [original]);
  assert.equal(result[0], original);
});

test("recursively collects all directory batches and preserves relative paths", async () => {
  const { collectDroppedFiles } = await loadSubject();
  const nested = directoryEntry("root", [
    [fileEntry("one.txt"), directoryEntry("sub", [[fileEntry("two.txt")], []])],
    [fileEntry("three.txt")],
    [],
  ]);
  const result = await collectDroppedFiles(transfer([{
    webkitGetAsEntry: () => nested,
    getAsFile: () => null,
  }]));

  assert.deepEqual(result.map((file) => file.name), [
    "root/one.txt",
    "root/sub/two.txt",
    "root/three.txt",
  ]);
  assert.equal(await result[1].text(), "two.txt");
});

test("skips dependency and metadata directories", async () => {
  const { collectDroppedFiles } = await loadSubject();
  const root = directoryEntry("root", [[
    directoryEntry(".git", [[fileEntry("config")], []]),
    directoryEntry("node_modules", [[fileEntry("package.js")], []]),
    directoryEntry(".next", [[fileEntry("cache")], []]),
    fileEntry("keep.txt"),
  ], []]);
  const result = await collectDroppedFiles(transfer([{
    webkitGetAsEntry: () => root,
    getAsFile: () => null,
  }]));

  assert.deepEqual(result.map((file) => file.name), ["root/keep.txt"]);
});

test("bounds recursive traversal", async () => {
  const { collectDroppedFiles, MAX_DROP_ENTRIES } = await loadSubject();
  const entries = Array.from({ length: MAX_DROP_ENTRIES }, (_, index) => fileEntry(`${index}.txt`));
  const root = directoryEntry("root", [entries, []]);

  await assert.rejects(
    collectDroppedFiles(transfer([{ webkitGetAsEntry: () => root, getAsFile: () => null }])),
    /at most 10000 entries/,
  );
});
