import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const fixture = await mkdtemp(join(tmpdir(), "pi-web-file-index-route-"));
const cwd = join(fixture, "workspace");
const external = join(fixture, "shared-docs");
await Promise.all([
  mkdir(join(cwd, "src"), { recursive: true }),
  mkdir(join(external, "guides"), { recursive: true }),
]);
await Promise.all([
  writeFile(join(cwd, "src", "local.ts"), "export {};\n"),
  writeFile(join(external, "guides", "remote.md"), "# Remote\n"),
]);

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET } = await jiti.import("./route.ts");
allowFileRoot(cwd);
allowFileRoot(external);
allowFileRoot(process.cwd());

after(() => rm(fixture, { recursive: true, force: true }));

function request(url) {
  return { nextUrl: new URL(url) };
}

test("preserves the cwd-only response contract when searchRoot is omitted", async () => {
  const response = await GET(request(`http://localhost/api/file-index?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["files", "truncated"]);
  assert.ok(body.files.includes("src/local.ts"));
});

test("searches the cwd and explicit authorized roots with root metadata", async () => {
  const url = new URL("http://localhost/api/file-index");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("q", `${basename(external)}/remote`);
  url.searchParams.append("searchRoot", external);
  const response = await GET(request(url));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.roots, [{ alias: basename(external), path: external, truncated: false }]);
  assert.deepEqual(body.matches, [{
    path: join(external, "guides", "remote.md").replaceAll("\\", "/"),
    isDir: false,
    rootAlias: basename(external),
    relativePath: "guides/remote.md",
  }]);
  assert.equal(body.truncated, false);
});

test("resolves the pi-web alias to the running checkout", async () => {
  const url = new URL("http://localhost/api/file-index");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("q", "file-search-roots");
  url.searchParams.append("searchRoot", "pi-web");
  const response = await GET(request(url));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.roots[0].alias, "pi-web");
  assert.equal(body.roots[0].path, process.cwd());
  assert.ok(body.matches.some((entry) => (
    entry.rootAlias === "pi-web" && entry.relativePath === "lib/file-search-roots.ts"
  )));
});

test("rejects an unauthorized explicit search root", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pi-web-file-index-outside-"));
  try {
    const url = new URL("http://localhost/api/file-index");
    url.searchParams.set("cwd", cwd);
    url.searchParams.append("searchRoot", outside);
    const response = await GET(request(url));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Access denied" });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
