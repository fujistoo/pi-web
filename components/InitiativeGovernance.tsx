"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GovernanceCandidate,
  GovernanceState,
  JiraWorkItem,
} from "@/lib/initiative-governance";
import styles from "./InitiativeGovernance.module.css";

type Filter = "missing" | "needs-epic" | "linked" | "errors";

type CandidatesResponse = {
  candidates?: GovernanceCandidate[];
  refreshedAt?: string;
  error?: string;
};

const FILTER_LABELS: Record<Filter, string> = {
  missing: "missing project",
  "needs-epic": "needs epic",
  linked: "linked",
  errors: "errors",
};

const STATE_LABELS: Record<GovernanceState, string> = {
  missing_project: "Missing",
  project_created: "Project created",
  needs_epic: "Needs epic",
  ready_to_link: "Ready to link",
  linked: "Linked",
  error: "Error",
};

function matchesFilter(candidate: GovernanceCandidate, filter: Filter): boolean {
  if (filter === "missing") return candidate.state === "missing_project" || candidate.state === "project_created";
  if (filter === "needs-epic") return candidate.state === "needs_epic" || candidate.state === "ready_to_link";
  if (filter === "linked") return candidate.state === "linked";
  return candidate.state === "error";
}

function formatUpdated(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

async function responsePayload<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? fallback);
  return payload;
}

export default function InitiativeGovernance() {
  const [filter, setFilter] = useState<Filter>("missing");
  const [search, setSearch] = useState("");
  const [roadmaps, setRoadmaps] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<GovernanceCandidate[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [inspectedKey, setInspectedKey] = useState<string>();
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [creatingKey, setCreatingKey] = useState<string>();
  const [isCreatingBulk, setIsCreatingBulk] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [refreshError, setRefreshError] = useState<string>();
  const [workSearch, setWorkSearch] = useState("");
  const [workItems, setWorkItems] = useState<JiraWorkItem[]>([]);
  const [selectedWorkId, setSelectedWorkId] = useState<string>();
  const [isSearchingWork, setIsSearchingWork] = useState(false);
  const [linkingWorkId, setLinkingWorkId] = useState<string>();

  const availableRoadmaps = useMemo(() => Array.from(new Set(
    candidates.map((candidate) => candidate.roadmap).filter((value): value is string => Boolean(value)),
  )), [candidates]);

  const visibleCandidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    return candidates.filter((candidate) => {
      if (!matchesFilter(candidate, filter)) return false;
      if (roadmaps.length > 0 && (!candidate.roadmap || !roadmaps.includes(candidate.roadmap))) return false;
      return !term
        || candidate.ideaKey.toLowerCase().includes(term)
        || candidate.summary.toLowerCase().includes(term);
    });
  }, [candidates, filter, roadmaps, search]);

  const inspected = candidates.find((candidate) => candidate.ideaKey === inspectedKey)
    ?? visibleCandidates[0];
  const missingCount = candidates.filter((candidate) => candidate.state === "missing_project").length;

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setRefreshError(undefined);
    try {
      const response = await fetch("/api/initiatives", { cache: "no-store" });
      const payload = await responsePayload<CandidatesResponse>(response, "Unable to refresh ZTK ideas.");
      const nextCandidates = payload.candidates ?? [];
      setCandidates(nextCandidates);
      setRefreshedAt(payload.refreshedAt);
      setSelectedKeys([]);
      setRowErrors({});
      setInspectedKey(nextCandidates.find((candidate) => candidate.state === "missing_project")?.ideaKey);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Unable to refresh ZTK ideas.");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleRoadmap(roadmap: string) {
    setRoadmaps((current) => current.includes(roadmap)
      ? current.filter((item) => item !== roadmap)
      : [...current, roadmap]);
  }

  function toggleSelection(ideaKey: string) {
    setSelectedKeys((current) => current.includes(ideaKey)
      ? current.filter((key) => key !== ideaKey)
      : [...current, ideaKey]);
  }

  async function createProjectForKey(ideaKey: string): Promise<void> {
    setCreatingKey(ideaKey);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[ideaKey];
      return next;
    });
    try {
      const response = await fetch(`/api/initiatives/${encodeURIComponent(ideaKey)}/project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await responsePayload<{
        projectAri?: string;
        projectName?: string;
        projectUrl?: string;
      }>(response, "Unable to create an Atlassian Project.");
      if (!payload.projectAri) throw new Error("Atlassian did not return a project.");
      setCandidates((current) => current.map((candidate) => candidate.ideaKey === ideaKey
        ? {
            ...candidate,
            projectAri: payload.projectAri,
            projectName: payload.projectName,
            projectUrl: payload.projectUrl,
            state: "project_created",
          }
        : candidate));
      setSelectedKeys((current) => current.filter((key) => key !== ideaKey));
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [ideaKey]: error instanceof Error ? error.message : "Unable to create an Atlassian Project.",
      }));
      throw error;
    } finally {
      setCreatingKey(undefined);
    }
  }

  async function createSelectedProjects() {
    const keys = selectedKeys.filter((key) =>
      candidates.some((candidate) => candidate.ideaKey === key && !candidate.projectAri));
    if (keys.length === 0) return;
    setIsCreatingBulk(true);
    for (const key of keys) {
      try {
        await createProjectForKey(key);
      } catch {
        // Each row records its own failure; continue processing the remaining selection.
      }
    }
    setIsCreatingBulk(false);
  }

  async function searchWorkItems(term = workSearch) {
    if (!inspected?.projectAri || !term.trim()) return;
    setIsSearchingWork(true);
    setRowErrors((current) => ({ ...current, [inspected.ideaKey]: "" }));
    try {
      const query = new URLSearchParams({ projectId: inspected.projectAri, q: term.trim() });
      const response = await fetch(`/api/initiatives/work-items?${query}`, { cache: "no-store" });
      const payload = await responsePayload<{ items?: JiraWorkItem[] }>(response, "Unable to search Jira work items.");
      setWorkItems(payload.items ?? []);
      setSelectedWorkId(undefined);
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [inspected.ideaKey]: error instanceof Error ? error.message : "Unable to search Jira work items.",
      }));
    } finally {
      setIsSearchingWork(false);
    }
  }

  async function linkWorkItem(item: JiraWorkItem) {
    if (!inspected?.projectAri) return;
    const idea = inspected;
    setLinkingWorkId(item.id);
    setRowErrors((current) => ({ ...current, [idea.ideaKey]: "" }));
    try {
      const ideaResponse = await fetch(`/api/initiatives/${encodeURIComponent(idea.ideaKey)}/work-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemKey: item.key }),
      });
      await responsePayload<{ success?: boolean }>(ideaResponse, "Unable to link the work item to the idea.");

      const projectResponse = await fetch("/api/initiatives/work-items/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: idea.projectAri, workItemId: item.parentId ?? item.id }),
      });
      const linked = await responsePayload<{ key?: string; summary?: string }>(
        projectResponse,
        "Unable to link the Jira work item.",
      );
      setCandidates((current) => current.map((candidate) => candidate.ideaKey === idea.ideaKey
        ? {
            ...candidate,
            epicKey: item.parentKey ?? linked.key,
            epicSummary: item.parentSummary ?? linked.summary,
            state: "linked",
          }
        : candidate));
      setWorkItems([]);
      setSelectedWorkId(undefined);
      setWorkSearch("");
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [idea.ideaKey]: error instanceof Error ? error.message : "Unable to link the Jira work item.",
      }));
    } finally {
      setLinkingWorkId(undefined);
    }
  }

  return (
    <section className={styles.workspace} aria-label="Initiative governance">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>ZTK / product operations</p>
          <h1 className={styles.title}>initiative governance</h1>
        </div>
        <div className={styles.headerActions}>
          <p className={styles.summary} aria-live="polite">
            {isRefreshing
              ? "refreshing current state"
              : `${candidates.length} ideas · ${missingCount} missing${refreshedAt
                ? ` · refreshed ${new Date(refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : ""}`}
          </p>
          <input
            aria-label="Search ideas by key or summary"
            className={styles.input}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search ideas..."
            type="search"
            value={search}
          />
          <button className={styles.button} disabled={isRefreshing} onClick={() => void refresh()} type="button">
            {isRefreshing ? "● REFRESHING" : "REFRESH"}
          </button>
        </div>
      </header>

      <div className={styles.filterRail}>
        <nav aria-label="Initiative status filters" className={styles.filters}>
          {(Object.keys(FILTER_LABELS) as Filter[]).map((key) => (
            <button
              aria-pressed={filter === key}
              className={filter === key ? styles.filterActive : styles.filter}
              key={key}
              onClick={() => setFilter(key)}
              type="button"
            >
              {FILTER_LABELS[key]}
            </button>
          ))}
        </nav>
        {availableRoadmaps.length > 0 && (
          <fieldset className={styles.roadmaps}>
            <legend>roadmap</legend>
            {availableRoadmaps.map((roadmap) => (
              <label key={roadmap}>
                <input
                  checked={roadmaps.includes(roadmap)}
                  onChange={() => toggleRoadmap(roadmap)}
                  type="checkbox"
                />
                {roadmap}
              </label>
            ))}
          </fieldset>
        )}
      </div>

      <div className={styles.split}>
        <div className={styles.tableRegion}>
          {selectedKeys.length > 0 && (
            <div className={styles.bulkRail}>
              <span>{selectedKeys.length} selected</span>
              <span>
                <button disabled={isCreatingBulk} onClick={() => void createSelectedProjects()} type="button">
                  {isCreatingBulk ? `CREATING ${creatingKey ?? "PROJECTS"}` : "CREATE PROJECTS"}
                </button>
                <button onClick={() => setSelectedKeys([])} type="button">CLEAR</button>
              </span>
            </div>
          )}
          {refreshError && <p className={styles.error} role="alert">Refresh failed: {refreshError}</p>}
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>idea</th>
                  <th>summary</th>
                  <th>status</th>
                  <th>roadmap</th>
                  <th>initiative type</th>
                  <th>Jira Epic</th>
                  <th>Atlassian Project</th>
                  <th>updated</th>
                </tr>
              </thead>
              <tbody>
                {visibleCandidates.map((candidate) => (
                  <tr className={inspected?.ideaKey === candidate.ideaKey ? styles.inspected : undefined} key={candidate.ideaKey}>
                    <td>
                      <input
                        aria-label={`Select ${candidate.ideaKey}`}
                        checked={selectedKeys.includes(candidate.ideaKey)}
                        disabled={Boolean(candidate.projectAri)}
                        onChange={() => toggleSelection(candidate.ideaKey)}
                        type="checkbox"
                      />
                    </td>
                    <td><button className={styles.rowButton} onClick={() => setInspectedKey(candidate.ideaKey)} type="button">{candidate.ideaKey}</button></td>
                    <td><button className={styles.rowButton} onClick={() => setInspectedKey(candidate.ideaKey)} type="button">{candidate.summary}</button></td>
                    <td>{candidate.status}</td>
                    <td>{candidate.roadmap ?? "—"}</td>
                    <td>{candidate.initiativeType ?? "—"}</td>
                    <td className={styles.mono}>{candidate.epicKey ?? "—"}</td>
                    <td><span className={styles.state}>{STATE_LABELS[candidate.state]}</span></td>
                    <td>{formatUpdated(candidate.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isRefreshing && visibleCandidates.length === 0 && (
              <p className={styles.empty}>{candidates.length === 0 ? "No initiatives loaded." : "No initiatives match these filters."}</p>
            )}
          </div>
        </div>

        <aside className={styles.inspector} aria-label="Initiative inspector">
          {inspected ? (
            <>
              <p className={`${styles.eyebrow} ${styles.mono}`}>{inspected.ideaKey}</p>
              <h2>{inspected.summary}</h2>
              <dl>
                <div><dt>status</dt><dd>{inspected.status}</dd></div>
                <div><dt>roadmap</dt><dd>{inspected.roadmap ?? "—"}</dd></div>
                <div><dt>initiative type</dt><dd>{inspected.initiativeType ?? "—"}</dd></div>
                <div><dt>atlassian project</dt><dd className={styles.mono}>{inspected.projectUrl ? <a href={inspected.projectUrl} rel="noreferrer" target="_blank">OPEN PROJECT ↗</a> : inspected.projectAri ?? "Not created"}</dd></div>
                <div><dt>Jira epic</dt><dd className={styles.mono}>{inspected.epicKey ?? "None"}</dd></div>
              </dl>
              {rowErrors[inspected.ideaKey] && <p className={styles.error} role="alert">{rowErrors[inspected.ideaKey]}</p>}
              <button
                className={`${styles.button} ${styles.fullWidth}`}
                disabled={Boolean(inspected.projectAri) || Boolean(creatingKey) || isCreatingBulk}
                onClick={() => void createProjectForKey(inspected.ideaKey).catch(() => undefined)}
                type="button"
              >
                {inspected.projectAri ? "PROJECT LINKED" : creatingKey === inspected.ideaKey ? "● CREATING PROJECT" : "CREATE PROJECT"}
              </button>
              <p className={styles.note}>Creation is explicit. The project is linked back to the idea immediately.</p>

              {inspected.projectAri && !inspected.epicKey && (
                <section className={styles.workLinker}>
                  <p className={styles.eyebrow}>Jira work</p>
                  <div className={styles.workSearch}>
                    <input
                      aria-label="Search Jira work items"
                      className={styles.input}
                      onChange={(event) => setWorkSearch(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") void searchWorkItems(); }}
                      placeholder="Search Jira work..."
                      type="search"
                      value={workSearch}
                    />
                    <button className={styles.button} disabled={isSearchingWork || !workSearch.trim()} onClick={() => void searchWorkItems()} type="button">
                      {isSearchingWork ? "SEARCHING" : "SEARCH"}
                    </button>
                  </div>
                  <button className={`${styles.button} ${styles.fullWidth}`} disabled={isSearchingWork} onClick={() => { setWorkSearch(inspected.summary); void searchWorkItems(inspected.summary); }} type="button">RECOMMEND</button>
                  {workItems.length > 0 && (
                    <div className={styles.workPicker} role="listbox" aria-label="Jira work item matches">
                      {workItems.map((item) => (
                        <button
                          aria-selected={selectedWorkId === item.id}
                          className={selectedWorkId === item.id ? styles.workResultSelected : styles.workResult}
                          key={item.id}
                          onClick={() => setSelectedWorkId(item.id)}
                          role="option"
                          type="button"
                        >
                          <strong className={styles.mono}>{item.key}</strong>
                          <span>{item.summary}</span>
                          <small>{item.recommendation}</small>
                        </button>
                      ))}
                      <button
                        className={`${styles.button} ${styles.fullWidth}`}
                        disabled={!selectedWorkId || Boolean(linkingWorkId)}
                        onClick={() => {
                          const item = workItems.find((candidate) => candidate.id === selectedWorkId);
                          if (item) void linkWorkItem(item);
                        }}
                        type="button"
                      >
                        {linkingWorkId ? "● LINKING" : "LINK SELECTED WORK"}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          ) : (
            <p className={styles.note}>Select an idea after the refresh completes.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
