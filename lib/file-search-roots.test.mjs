import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const subject = await jiti.import("./file-search-roots.ts");

test("resolves pi-web, tilde, and absolute roots only after allow-list authorization", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-web-search-roots-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const cwd = join(fixture, "cwd");
  const checkout = join(fixture, "checkout");
  const homeProject = join(fixture, "home", "notes");
  await Promise.all([mkdir(cwd), mkdir(checkout), mkdir(homeProject, { recursive: true })]);
  const allowed = new Set([cwd, checkout, homeProject]);

  assert.deepEqual(
    subject.resolveFileSearchRoots(
      ["pi-web", "~/notes", homeProject],
      cwd,
      allowed,
      { piWebRoot: checkout, home: join(fixture, "home") },
    ),
    [
      { alias: "pi-web", path: checkout },
      { alias: "notes", path: homeProject },
    ],
  );
});

test("rejects relative and unauthorized search roots", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-web-search-roots-denied-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const cwd = join(fixture, "cwd");
  const outside = join(fixture, "outside");
  await Promise.all([mkdir(cwd), mkdir(outside)]);

  assert.throws(
    () => subject.resolveFileSearchRoots(["relative/path"], cwd, new Set([cwd])),
    (error) => error instanceof subject.FileSearchRootError && error.status === 400,
  );
  assert.throws(
    () => subject.resolveFileSearchRoots([outside], cwd, new Set([cwd])),
    (error) => error instanceof subject.FileSearchRootError && error.status === 403,
  );
});
