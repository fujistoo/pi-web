"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("child_process");

const DEFAULT_REMOTE = "upstream";
const DEFAULT_BRANCH = "main";
// The published package name; a fork can keep it, so this is only a sanity check
// that the directory really is a Pi Web checkout and not a random repo.
const PACKAGE_NAME = "@agegr/pi-web";

function makeRun(options) {
  return options.run ?? ((args, runOptions) => spawnSync(options.gitCommand ?? "git", args, runOptions));
}

function git(run, args, cwd, options = {}) {
  const result = run(args, { cwd, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

/** Runs a git command that must succeed, returning trimmed stdout. */
function gitOutput(run, args, cwd) {
  const result = git(run, args, cwd);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n")[0];
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Fetches a remote and merges it into the current branch.
 *
 * A conflicting merge is always aborted, so a failure leaves the worktree
 * exactly as it was found; resolving conflicts stays a deliberate step in an
 * editor. Never fetches into a dirty worktree, because `git merge` would either
 * refuse or lose uncommitted work.
 */
function syncUpstream(directory, options = {}) {
  const run = makeRun(options);
  const resolvedDir = path.resolve(directory);
  const remote = options.remote ?? DEFAULT_REMOTE;
  const branch = options.branch ?? DEFAULT_BRANCH;

  let packageName;
  try {
    packageName = JSON.parse(fs.readFileSync(path.join(resolvedDir, "package.json"), "utf8")).name;
  } catch {
    throw new Error(`Not a Pi Web checkout: ${resolvedDir}`);
  }
  if (packageName !== PACKAGE_NAME) {
    throw new Error(`Expected ${PACKAGE_NAME} in ${path.join(resolvedDir, "package.json")}`);
  }

  const insideWorkTree = gitOutput(run, ["rev-parse", "--is-inside-work-tree"], resolvedDir);
  if (insideWorkTree !== "true") throw new Error(`Not a git work tree: ${resolvedDir}`);

  if (git(run, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], resolvedDir).status === 0) {
    throw new Error("A merge is already in progress. Resolve it, or run `git merge --abort`, then retry.");
  }

  const branchName = gitOutput(run, ["rev-parse", "--abbrev-ref", "HEAD"], resolvedDir);
  if (branchName === "HEAD") {
    throw new Error("Cannot sync a detached HEAD. Check out a branch first.");
  }

  const dirty = gitOutput(run, ["status", "--porcelain"], resolvedDir);
  if (dirty) {
    const count = dirty.split("\n").length;
    throw new Error(
      `The work tree has ${count} uncommitted change${count === 1 ? "" : "s"}. Commit or stash them before syncing.`,
    );
  }

  const fetch = git(run, ["fetch", remote], resolvedDir);
  if (fetch.status !== 0) {
    const detail = (fetch.stderr ?? "").trim().split("\n").pop();
    throw new Error(`git fetch ${remote} failed${detail ? `: ${detail}` : ""}`);
  }

  const target = `${remote}/${branch}`;
  const ahead = gitOutput(run, ["rev-list", "--count", `${target}..HEAD`], resolvedDir);
  const behind = Number(gitOutput(run, ["rev-list", "--count", `HEAD..${target}`], resolvedDir));
  const before = gitOutput(run, ["rev-parse", "HEAD"], resolvedDir);

  if (behind === 0) {
    return {
      message: `Already up to date with ${target} (${ahead} local commit${ahead === "1" ? "" : "s"} ahead).`,
      updated: false,
      branch: branchName,
      behind: 0,
      ahead: Number(ahead),
      target,
    };
  }

  // --no-edit keeps a clean merge from blocking on an editor.
  const merge = git(run, ["merge", "--no-edit", target], resolvedDir);
  if (merge.status !== 0) {
    const conflicts = gitOutput(run, ["diff", "--name-only", "--diff-filter=U"], resolvedDir)
      .split("\n")
      .filter(Boolean);
    git(run, ["merge", "--abort"], resolvedDir);
    if (conflicts.length === 0) {
      const detail = (merge.stderr ?? "").trim();
      throw new Error(`git merge ${target} failed and was aborted.\n${detail}`);
    }
    throw new Error([
      `Merging ${target} conflicts in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}; the merge was aborted.`,
      "",
      ...conflicts.map((file) => `  ${file}`),
      "",
      `Resolve it deliberately: \`git merge ${target}\`, fix these files, commit, then run \`pi-web update <directory>\`.`,
    ].join("\n"));
  }

  return {
    message: [
      `Merged ${target} into ${branchName} (${behind} commit${behind === 1 ? "" : "s"}).`,
      `Undo with: git reset --hard ${before}`,
      "Next: `pi-web update <directory>` to rebuild and restart.",
    ].join("\n"),
    updated: true,
    branch: branchName,
    behind,
    ahead: Number(ahead),
    target,
    previousHead: before,
  };
}

module.exports = { syncUpstream, DEFAULT_REMOTE, DEFAULT_BRANCH };
