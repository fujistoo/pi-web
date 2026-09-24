import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { syncUpstream } = await import("../bin/sync-upstream.js");

function makeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sync-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@agegr/pi-web", version: "0.0.0" }),
  );
  return root;
}

/** Fake git that only answers the calls syncUpstream is allowed to make. */
function makeGit(overrides = {}) {
  const calls = [];
  const table = {
    "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n" },
    "rev-parse --verify --quiet MERGE_HEAD": { status: 1, stdout: "" },
    "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "main\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "fetch upstream": { status: 0, stdout: "" },
    "rev-list --count upstream/main..HEAD": { status: 0, stdout: "2\n" },
    "rev-list --count HEAD..upstream/main": { status: 0, stdout: "3\n" },
    "rev-parse HEAD": { status: 0, stdout: "aaaaaaaa\n" },
    "merge --no-edit upstream/main": { status: 0, stdout: "" },
    ...overrides,
  };

  const run = (args) => {
    const key = args.join(" ");
    calls.push(key);
    const result = table[key];
    if (!result) throw new Error(`unexpected git call: ${key}`);
    return { stdout: "", stderr: "", ...result };
  };

  return { run, calls };
}

test("merges the fetched upstream branch and reports the undo command", () => {
  const root = makeCheckout();
  const { run, calls } = makeGit();

  const result = syncUpstream(root, { run });

  assert.equal(result.updated, true);
  assert.equal(result.behind, 3);
  assert.match(result.message, /Merged upstream\/main into main \(3 commits\)/);
  assert.match(result.message, /git reset --hard aaaaaaaa/);
  assert.deepEqual(calls, [
    "rev-parse --is-inside-work-tree",
    "rev-parse --verify --quiet MERGE_HEAD",
    "rev-parse --abbrev-ref HEAD",
    "status --porcelain",
    "fetch upstream",
    "rev-list --count upstream/main..HEAD",
    "rev-list --count HEAD..upstream/main",
    "rev-parse HEAD",
    "merge --no-edit upstream/main",
  ]);
});

test("aborts a conflicting merge and names every conflicted file", () => {
  const root = makeCheckout();
  const { run, calls } = makeGit({
    "merge --no-edit upstream/main": { status: 1, stderr: "CONFLICT (content)" },
    "diff --name-only --diff-filter=U": {
      status: 0,
      stdout: "components/SessionSidebar.tsx\ncomponents/SessionSidebar.test.mjs\n",
    },
    "merge --abort": { status: 0 },
  });

  assert.throws(
    () => syncUpstream(root, { run }),
    (error) => {
      assert.match(error.message, /conflicts in 2 files; the merge was aborted/);
      assert.match(error.message, /components\/SessionSidebar\.tsx/);
      assert.match(error.message, /components\/SessionSidebar\.test\.mjs/);
      return true;
    },
  );
  // The abort is what keeps a failure from leaving a conflicted work tree.
  assert.ok(calls.includes("merge --abort"));
});

test("never fetches into a dirty work tree", () => {
  const root = makeCheckout();
  const { run, calls } = makeGit({ "status --porcelain": { status: 0, stdout: " M app/page.tsx\n" } });

  assert.throws(() => syncUpstream(root, { run }), /1 uncommitted change/);
  assert.ok(!calls.includes("fetch upstream"));
});

test("reports an up-to-date branch without merging", () => {
  const root = makeCheckout();
  const { run, calls } = makeGit({ "rev-list --count HEAD..upstream/main": { status: 0, stdout: "0\n" } });

  const result = syncUpstream(root, { run });

  assert.equal(result.updated, false);
  assert.match(result.message, /Already up to date with upstream\/main \(2 local commits ahead\)/);
  assert.ok(!calls.some((call) => call.startsWith("merge ")));
});

test("refuses mid-merge, detached HEAD, and non-Pi-Web directories", () => {
  const root = makeCheckout();

  assert.throws(
    () => syncUpstream(root, { run: makeGit({ "rev-parse --verify --quiet MERGE_HEAD": { status: 0 } }).run }),
    /A merge is already in progress/,
  );
  assert.throws(
    () => syncUpstream(root, { run: makeGit({ "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "HEAD\n" } }).run }),
    /Cannot sync a detached HEAD/,
  );

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-other-"));
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "not-pi-web" }));
  assert.throws(() => syncUpstream(other, { run: makeGit().run }), /Expected @agegr\/pi-web/);
});
