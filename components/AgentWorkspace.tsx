"use client";

import { useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { MarkdownBody } from "./MarkdownBody";
import { PixelAgentsOffice } from "./PixelAgentsOffice";

interface Props {
  sessionId: string | null;
  subagents: SessionInfo[];
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
}

type PreviewMessage = { role?: string; content?: unknown };

function messageText(message: PreviewMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function AgentTranscript({ session, running, onSelect }: { session: SessionInfo; running: boolean; onSelect: () => void }) {
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}?tail=30&deferThinking&deferMedia`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { context?: { messages?: PreviewMessage[] } };
        if (!cancelled) { setMessages(data.context?.messages ?? []); setError(null); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    if (!running) return () => { cancelled = true; };
    const timer = window.setInterval(load, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [running, session.id, session.modified]);

  return (
    <section style={{ minWidth: 280, flex: "1 1 360px", display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", overflow: "hidden" }}>
      <button type="button" onClick={onSelect} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: 0, borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: running ? "var(--accent)" : "var(--text-dim)" }} />
        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{session.relation?.kind === "subagent" ? session.relation.description : session.name || session.id}</strong>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{running ? "running" : "view chat"}</span>
      </button>
      <div style={{ minHeight: 120, maxHeight: 360, overflowY: "auto", padding: 12 }}>
        {error && <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>}
        {!error && messages.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No messages yet.</div>}
        {messages.slice(-8).map((message, index) => {
          const text = messageText(message);
          if (!text) return null;
          return <div key={index} style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.5 }}><div style={{ marginBottom: 3, color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase" }}>{message.role}</div><MarkdownBody>{text}</MarkdownBody></div>;
        })}
      </div>
    </section>
  );
}

export function AgentWorkspace({ sessionId, subagents, runningSessionIds, onSelectSession }: Props) {
  const [view, setView] = useState<"office" | "chats">("office");
  return (
    <aside id="agents-workspace" aria-label="Subagent workspace" style={{ width: "100%", minWidth: 0, height: "100%", display: "flex", flexDirection: "column", gap: 10, padding: 12, background: "var(--bg)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
        <button type="button" onClick={() => setView("office")} aria-pressed={view === "office"} style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: view === "office" ? "var(--bg-selected)" : "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}>Office</button>
        <button type="button" onClick={() => setView("chats")} aria-pressed={view === "chats"} style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: view === "chats" ? "var(--bg-selected)" : "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}>Chats</button>
      </header>
      {view === "office" ? (
        <PixelAgentsOffice sessionId={sessionId} />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, overflowY: "auto", alignContent: "flex-start" }}>
          {subagents.map((session) => <AgentTranscript key={session.id} session={session} running={runningSessionIds.has(session.id)} onSelect={() => onSelectSession(session)} />)}
        </div>
      )}
    </aside>
  );
}
