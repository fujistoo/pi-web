"use client";

import { useEffect, useState } from "react";

interface Props {
  previewId: string;
  cwd?: string;
  title: string;
  liveLabel: string;
  loadingLabel: string;
  unavailableLabel: string;
}

const POLL_INTERVAL_MS = 1000;

export function LivePreviewPanel({
  previewId,
  cwd,
  title,
  liveLabel,
  loadingLabel,
  unavailableLabel,
}: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/previews/${encodeURIComponent(previewId)}`;
  const requestUrl = cwd ? `${endpoint}?cwd=${encodeURIComponent(cwd)}` : endpoint;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);

    const load = async () => {
      try {
        const separator = requestUrl.includes("?") ? "&" : "?";
        const response = await fetch(`${requestUrl}${separator}v=${Date.now()}`, { cache: "no-store" });
        if (response.status === 404) {
          if (!cancelled) {
            setHtml(null);
            setError(unavailableLabel);
          }
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextHtml = await response.text();
        if (cancelled) return;
        setHtml((current) => current === nextHtml ? current : nextHtml);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [unavailableLabel, requestUrl]);

  return (
    <section aria-label={title} style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32, padding: "0 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: error ? "#f87171" : "#4ade80", boxShadow: error ? "none" : "0 0 5px #4ade80" }} aria-hidden="true" />
        <span>{error ?? liveLabel}</span>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0, background: "var(--bg)" }}>
        <iframe
          srcDoc={html ?? ""}
          sandbox=""
          referrerPolicy="no-referrer"
          title={title}
          style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
        />
        {!html && (
          <div role="status" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, pointerEvents: "none" }}>
            {error ?? loadingLabel}
          </div>
        )}
      </div>
    </section>
  );
}
