import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates relative upload paths by segment", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "folder/two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /Invalid upload path/);
  assert.match(validateUploadFileNames(["folder/../secret.txt"]), /Invalid upload path/);
  assert.match(validateUploadFileNames(["folder//secret.txt"]), /Invalid upload path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /Invalid upload path/);
  assert.match(validateUploadFileNames(["/secret.txt"]), /Invalid upload path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("creates nested parents and writes files without flattening paths", async (t) => {
  const { ensureUploadParentDirectory, writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const destination = ensureUploadParentDirectory(root, "folder/nested/file.txt");
  writeUploadFile(destination, Buffer.from("hello"), false);

  assert.equal(fs.readFileSync(path.join(root, "folder/nested/file.txt"), "utf8"), "hello");
});

test("rejects symlink and file parent components", async (t) => {
  const { ensureUploadParentDirectory, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-parent-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "parent-file"), "x");
  try {
    fs.symlinkSync(outside, path.join(root, "parent-link"), "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(inspectUploadTargets(root, ["parent-file/a.txt", "parent-link/b.txt"]), {
    conflicts: ["parent-file/a.txt", "parent-link/b.txt"],
    nonReplaceable: ["parent-file/a.txt", "parent-link/b.txt"],
  });
  assert.throws(() => ensureUploadParentDirectory(root, "parent-file/a.txt"), /not a directory/);
  assert.throws(() => ensureUploadParentDirectory(root, "parent-link/b.txt"), /not a directory/);
  assert.equal(fs.existsSync(path.join(outside, "b.txt")), false);
});

test("overwrite changes regular files but never directories or symlinks", async (t) => {
  const { writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "file.txt");
  const directory = path.join(root, "directory");
  fs.writeFileSync(file, "old");
  fs.mkdirSync(directory);

  writeUploadFile(file, Buffer.from("new"), true);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.throws(() => writeUploadFile(directory, Buffer.from("bad"), true), /Cannot replace/);

  const link = path.join(root, "link.txt");
  try {
    fs.symlinkSync("file.txt", link);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  assert.throws(() => writeUploadFile(link, Buffer.from("bad"), true), /Cannot replace/);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});
