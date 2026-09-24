"use client";

import { useCallback, useEffect, useState } from "react";

type OfficeState =
  | { available: true; url: string; providerId: "pi" }
  | { available: false };

interface Props {
  sessionId: string | null;
}

export function PixelAgentsOffice({ sessionId }: Props) {
  const [office, setOffice] = useState<OfficeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setOffice({ available: false });
      setFrameError(false);
      setError(null);
      return;
    }
    try {
      const response = await fetch(`/api/pixel-agents?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as OfficeState;
      setOffice(next);
      setFrameError(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const unavailable = office?.available !== true || frameError;
  return (
    <section
      aria-label="Pixel Agents office"
      style={{
        minHeight: 360,
        flex: "1 1 520px",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: office?.available && !frameError ? "var(--accent)" : "var(--text-dim)" }} />
        <strong style={{ fontSize: 12 }}>Pixel office</strong>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {office?.available && !frameError ? "live" : "not connected"}
        </span>
      </header>
      {unavailable ? (
        <div style={{ display: "flex", flex: 1, minHeight: 300, flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
          <strong style={{ color: "var(--text)" }}>Start Pixel Agents in Pi mode</strong>
          <span style={{ maxWidth: 420, fontSize: 12, lineHeight: 1.5 }}>
            Run the Pixel Agents server with <code>--provider pi</code>, then retry here.
          </span>
          {error && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{error}</span>}
          <button type="button" onClick={() => void refresh()} style={{ marginTop: 4, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}>
            Retry
          </button>
        </div>
      ) : (
        <iframe
          title="Pixel Agents animated office"
          src={office.url}
          onLoad={() => setFrameError(false)}
          onError={() => setFrameError(true)}
          referrerPolicy="no-referrer"
          style={{ width: "100%", flex: 1, minHeight: 300, border: 0, background: "var(--bg)" }}
        />
      )}
    </section>
  );
}
