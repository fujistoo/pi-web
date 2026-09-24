"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PAN_ZOOM_REST, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomTo, type PanZoomView } from "@/lib/pan-zoom";

const BUTTON_STYLE = {
  width: 22,
  height: 22,
  padding: 0,
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 13,
  lineHeight: 1,
  cursor: "pointer",
} as const;

const READOUT_STYLE = {
  minWidth: 40,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  textAlign: "center",
  userSelect: "none",
} as const;

/** Wheel-zoom, drag-pan and double-click-reset wrapper for oversized content. */
export function PanZoomFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<PanZoomView>(PAN_ZOOM_REST);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => setView(PAN_ZOOM_REST), []);

  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    let point: { x: number; y: number } | undefined;
    if (viewport && clientX != null && clientY != null) {
      const rect = viewport.getBoundingClientRect();
      point = { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }
    setView((current) => zoomTo(current, next, point));
  }, []);

  // Native listener: React's onWheel is passive, so preventDefault is ignored.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(view.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event.clientX, event.clientY);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [view.zoom, zoomAt]);

  const endDrag = (viewport: HTMLDivElement, pointerId: number) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
  };

  return (
    <div
      ref={viewportRef}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (toolbarRef.current?.contains(event.target as Node)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        setView((current) => ({
          ...current,
          x: drag.x + event.clientX - drag.px,
          y: drag.y + event.clientY - drag.py,
        }));
      }}
      onPointerUp={(event) => endDrag(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => endDrag(event.currentTarget, event.pointerId)}
      onDoubleClick={reset}
      style={{
        position: "relative",
        flex: "1 1 0",
        alignSelf: "stretch",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        cursor: dragging ? "grabbing" : "grab",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
      >
        {children}
      </div>
      <div
        ref={toolbarRef}
        style={{
          position: "absolute",
          right: 8,
          bottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "3px 4px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          boxShadow: "0 1px 4px rgba(0, 0, 0, 0.12)",
        }}
      >
        <button
          type="button"
          style={BUTTON_STYLE}
          disabled={view.zoom <= ZOOM_MIN}
          onClick={() => zoomAt(view.zoom - ZOOM_STEP)}
          title={t("i18n.zoomOut")}
          aria-label={t("i18n.zoomOut")}
        >
          &minus;
        </button>
        <span style={READOUT_STYLE}>{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          style={BUTTON_STYLE}
          disabled={view.zoom >= ZOOM_MAX}
          onClick={() => zoomAt(view.zoom + ZOOM_STEP)}
          title={t("i18n.zoomIn")}
          aria-label={t("i18n.zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          style={BUTTON_STYLE}
          onClick={reset}
          title={t("i18n.fitToWidth")}
          aria-label={t("i18n.fitToWidth")}
        >
          &#8634;
        </button>
      </div>
    </div>
  );
}
