import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./pan-zoom.ts");
}

test("clamps zoom to the supported range", async () => {
  const { clampZoom, ZOOM_MIN, ZOOM_MAX } = await loadSubject();
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
});

test("zoomTo keeps the content under the pointer fixed", async () => {
  const { zoomTo } = await loadSubject();
  const view = { zoom: 1, x: 0, y: 0 };
  const point = { x: 100, y: -60 };
  const next = zoomTo(view, 2, point);

  assert.equal(next.zoom, 2);
  const contentBefore = { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
  const contentAfter = { x: (point.x - next.x) / next.zoom, y: (point.y - next.y) / next.zoom };
  assert.deepEqual(contentAfter, contentBefore);
});

test("zoomTo keeps the centre when no point is given", async () => {
  const { zoomTo } = await loadSubject();
  assert.deepEqual(zoomTo({ zoom: 1, x: 12, y: 8 }, 2), { zoom: 2, x: 12, y: 8 });
});

test("zoomTo returns the same view when clamped to the current zoom", async () => {
  const { zoomTo, ZOOM_MAX } = await loadSubject();
  const view = { zoom: ZOOM_MAX, x: 3, y: 4 };
  assert.equal(zoomTo(view, ZOOM_MAX + 1), view);
});

test("withPanZoomHtml leaves plain HTML untouched", async () => {
  const { withPanZoomHtml } = await loadSubject();
  const html = "<!doctype html><html><body><h1>Hello</h1></body></html>";
  assert.equal(withPanZoomHtml(html, { zoomIn: "in", zoomOut: "out", reset: "reset" }), html);
});

test("withPanZoomHtml injects the controller before the closing body tag", async () => {
  const { withPanZoomHtml } = await loadSubject();
  const html = "<html><body><svg viewBox='0 0 10 10'></svg></body></html>";
  const result = withPanZoomHtml(html, { zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset" });

  assert.ok(result.includes('id="pi-pan-zoom-bar"'));
  assert.ok(result.includes("Zoom out"));
  assert.ok(result.indexOf("pi-pan-zoom-bar") < result.indexOf("</body>"));
  assert.ok(result.endsWith("</body></html>"));
});

test("withPanZoomHtml appends when there is no closing body tag", async () => {
  const { withPanZoomHtml } = await loadSubject();
  const result = withPanZoomHtml("<svg></svg>", { zoomIn: "in", zoomOut: "out", reset: "reset" });
  assert.ok(result.startsWith("<svg></svg>"));
  assert.ok(result.includes('id="pi-pan-zoom-bar"'));
});

test("withPanZoomHtml escapes labels instead of injecting markup", async () => {
  const { withPanZoomHtml } = await loadSubject();
  const result = withPanZoomHtml("<svg></svg>", {
    zoomIn: '"><script>alert(1)</script>',
    zoomOut: "out",
    reset: "reset",
  });

  assert.ok(!result.includes("<script>alert(1)</script>"));
  assert.ok(result.includes("&quot;&gt;&lt;script&gt;"));
});
