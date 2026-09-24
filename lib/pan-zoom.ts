export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 0.25;

export interface PanZoomView {
  zoom: number;
  x: number;
  y: number;
}

export const PAN_ZOOM_REST: PanZoomView = { zoom: 1, x: 0, y: 0 };

export interface PanZoomPoint {
  x: number;
  y: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Next view when zooming to `next`. When `point` is given (viewport-relative
 * offset from the centre) the content under that point stays put, otherwise the
 * current centre is kept.
 */
export function zoomTo(view: PanZoomView, next: number, point?: PanZoomPoint): PanZoomView {
  const zoom = clampZoom(next);
  if (zoom === view.zoom) return view;
  if (!point) return { zoom, x: view.x, y: view.y };
  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: point.x + (view.x - point.x) * ratio,
    y: point.y + (view.y - point.y) * ratio,
  };
}

export interface PanZoomLabels {
  zoomIn: string;
  zoomOut: string;
  reset: string;
}

const TOOLBAR_ID = "pi-pan-zoom-bar";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Self-contained pan/zoom controller injected into an HTML preview. It runs
 * inside the sandboxed preview iframe, which the parent cannot reach into, so
 * the zoom maths is mirrored here rather than imported from `zoomTo`.
 */
function panZoomMarkup(labels: PanZoomLabels): string {
  const zoomIn = escapeAttribute(labels.zoomIn);
  const zoomOut = escapeAttribute(labels.zoomOut);
  const reset = escapeAttribute(labels.reset);

  return `
<style>
html,body{overflow:hidden}
#${TOOLBAR_ID}{position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:2px;padding:3px 4px;border:1px solid rgba(120,113,108,.35);border-radius:6px;background:rgba(250,250,249,.94);color:#57534e;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 4px rgba(0,0,0,.12)}
#${TOOLBAR_ID} button{width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}
#${TOOLBAR_ID} button:hover{background:rgba(120,113,108,.15)}
#${TOOLBAR_ID} span{min-width:40px;text-align:center;user-select:none}
</style>
<div id="${TOOLBAR_ID}">
<button type="button" data-pz="out" title="${zoomOut}" aria-label="${zoomOut}">&minus;</button>
<span data-pz="value">100%</span>
<button type="button" data-pz="in" title="${zoomIn}" aria-label="${zoomIn}">+</button>
<button type="button" data-pz="reset" title="${reset}" aria-label="${reset}">&#8634;</button>
</div>
<script>
(function () {
  var MIN = ${ZOOM_MIN}, MAX = ${ZOOM_MAX}, STEP = ${ZOOM_STEP};
  var bar = document.getElementById("${TOOLBAR_ID}");
  var readout = bar.querySelector("[data-pz=value]");
  var zoom = 1, x = 0, y = 0, ox = 0, oy = 0, drag = null;

  // Transform a wrapper, not body: a transformed body would drag the fixed
  // toolbar along with it and anchor it below the fold.
  var stage = document.createElement("div");
  stage.id = "pi-pan-zoom-stage";
  stage.style.transformOrigin = "0 0";
  while (document.body.firstChild) stage.appendChild(document.body.firstChild);
  document.body.appendChild(stage);
  document.body.appendChild(bar);

  function apply() {
    stage.style.transform = "translate(" + x + "px," + y + "px) scale(" + zoom + ")";
    readout.textContent = Math.round(zoom * 100) + "%";
  }
  function set(next, px, py) {
    next = Math.min(MAX, Math.max(MIN, next));
    if (next === zoom) return;
    if (typeof px === "number") {
      // Anchor the zoom on the pointer, measured from the stage origin.
      var qx = px - ox, qy = py - oy;
      var ratio = next / zoom;
      x = qx + (x - qx) * ratio;
      y = qy + (y - qy) * ratio;
    }
    zoom = next;
    apply();
  }
  function reset() { zoom = 1; x = 0; y = 0; apply(); }
  // Untransformed origin, so read it before the first apply().
  var box = stage.getBoundingClientRect();
  ox = box.left;
  oy = box.top;
  bar.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    var action = button.getAttribute("data-pz");
    if (action === "in") set(zoom + STEP);
    else if (action === "out") set(zoom - STEP);
    else reset();
  });
  window.addEventListener("wheel", function (event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    set(zoom + (event.deltaY < 0 ? STEP : -STEP), event.clientX, event.clientY);
  }, { passive: false });
  window.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest("#${TOOLBAR_ID}, a")) return;
    drag = { px: event.clientX, py: event.clientY, x: x, y: y };
    document.body.style.cursor = "grabbing";
  });
  window.addEventListener("pointermove", function (event) {
    if (!drag) return;
    x = drag.x + event.clientX - drag.px;
    y = drag.y + event.clientY - drag.py;
    apply();
  });
  window.addEventListener("pointerup", function () {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = "";
  });
  window.addEventListener("dblclick", function (event) {
    if (!(event.target instanceof Element) || event.target.closest("#${TOOLBAR_ID}")) return;
    reset();
  });
  apply();
})();
</script>`;
}

/**
 * Adds pan/zoom to an HTML preview, but only when it contains an inline SVG
 * (a diagram artifact). Returns the input unchanged otherwise, so ordinary HTML
 * files keep their natural scrolling.
 */
export function withPanZoomHtml(html: string, labels: PanZoomLabels): string {
  if (!/<svg[\s>]/i.test(html)) return html;
  const markup = panZoomMarkup(labels);
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${markup}</body>`)
    : `${html}${markup}`;
}
