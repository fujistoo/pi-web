export type GovernanceState =
  | "missing_project"
  | "project_created"
  | "needs_epic"
  | "ready_to_link"
  | "linked"
  | "error";

export interface GovernanceCandidate {
  ideaKey: string;
  ideaId: string;
  summary: string;
  status: string;
  roadmap?: string;
  initiativeType?: string;
  projectAri?: string;
  projectName?: string;
  projectUrl?: string;
  epicKey?: string;
  epicSummary?: string;
  updated: string;
  state: GovernanceState;
}

export interface JiraWorkItem {
  id: string;
  key: string;
  summary: string;
  webUrl: string;
  issueType?: string;
  recommendation?: string;
  parentKey?: string;
  parentId?: string;
  parentSummary?: string;
  score?: number;
}

export interface ProjectCreationResult {
  projectAri: string;
  projectName: string;
  projectUrl?: string;
  created: boolean;
}

type PolarisIssue = {
  id: number | string;
  key: string;
  fields: Record<string, unknown>;
};

type PolarisSearchResponse = {
  issues?: PolarisIssue[];
  statuses?: Record<string, { name?: string }>;
};

type PolarisFieldResponse = Record<string, Array<{
  key: string;
  options?: Array<{ id: number | string; value: string }>;
}>>;

const SITE_URL = "https://halcrowconsulting.atlassian.net";
const JPD_PROJECT_ID = "10331";
const JPD_PROJECT_KEY = "ZTK";
const PROJECT_FIELD = "customfield_11996";
const ROADMAP_FIELD = "customfield_10291";
const INITIATIVE_TYPE_FIELD = "customfield_12480";
const PROJECT_CONTAINER_ID = "ari:cloud:townsquare::site/408ebf99-49c5-4e24-80c7-f30510a0a310";
const ISSUE_LINK_TYPE_ID = "10211";
const ROADMAP_PRIORITY = ["Now", "Soon", "Later", "Someday", "New", "Done"];
const REQUESTED_FIELDS = [
  "summary",
  "status",
  "issuelinks",
  "updated",
  PROJECT_FIELD,
  ROADMAP_FIELD,
  INITIATIVE_TYPE_FIELD,
];

function credentials(): string {
  const auth = process.env.ACCESS_TOKEN;
  if (!auth) throw new Error("Atlassian credentials are not configured on the server.");
  return auth;
}

function projectAri(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionMap(fields: PolarisFieldResponse): Map<string, Map<string, string>> {
  const options = new Map<string, Map<string, string>>();
  for (const field of Object.values(fields).flat()) {
    if (field.options) {
      options.set(field.key, new Map(field.options.map((option) => [String(option.id), option.value])));
    }
  }
  return options;
}

function optionLabel(value: unknown, options: Map<string, string> | undefined): string | undefined {
  if (typeof value === "string" && !options) return value;
  if (typeof value === "number" || typeof value === "string") return options?.get(String(value));
  return undefined;
}

function normalizeIssue(
  issue: PolarisIssue,
  statuses: Record<string, { name?: string }>,
  options: Map<string, Map<string, string>>,
): GovernanceCandidate {
  const ari = projectAri(issue.fields[PROJECT_FIELD]);
  const updated = issue.fields.updated;
  return {
    ideaKey: issue.key,
    ideaId: String(issue.id),
    summary: typeof issue.fields.summary === "string" ? issue.fields.summary : "Untitled idea",
    status: statuses[String(issue.fields.status)]?.name ?? "Unknown",
    roadmap: optionLabel(issue.fields[ROADMAP_FIELD], options.get(ROADMAP_FIELD)),
    initiativeType: optionLabel(issue.fields[INITIATIVE_TYPE_FIELD], options.get(INITIATIVE_TYPE_FIELD)),
    projectAri: ari,
    updated: typeof updated === "number" ? new Date(updated).toISOString() : "",
    state: ari ? "project_created" : "missing_project",
  };
}

function roadmapIndex(roadmap?: string): number {
  const index = roadmap ? ROADMAP_PRIORITY.indexOf(roadmap) : -1;
  return index === -1 ? ROADMAP_PRIORITY.length : index;
}

async function atlassianRequest<T>(auth: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SITE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Atlassian returned ${response.status}.`);
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
  return await response.json() as T;
}

async function graphqlRequest<T>(
  auth: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${SITE_URL}/gateway/api/graphql`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operationName, query, variables }),
    cache: "no-store",
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message ?? `Atlassian returned ${response.status}.`);
  }
  return payload.data;
}

async function fetchFieldOptions(auth: string) {
  const fields = await atlassianRequest<PolarisFieldResponse>(
    auth,
    `/rest/polaris/v2/projects/${JPD_PROJECT_ID}/fields/?operation=getJpdFields`,
  );
  return optionMap(fields);
}

async function fetchActiveIdeas(auth: string): Promise<PolarisSearchResponse> {
  return atlassianRequest(auth, "/rest/polaris/issues/v3/search?operation=getJpdIdeas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jql: `project = ${JPD_PROJECT_KEY}`,
      fields: { fieldKeys: REQUESTED_FIELDS, all: false },
      include: { archived: "ACTIVE_ONLY", jpdProjectsOnly: true },
      pagination: { startAt: 0, max: 5000 },
    }),
  });
}

async function writeProjectToIdea(auth: string, ideaKey: string, ari: string): Promise<void> {
  await atlassianRequest<unknown>(auth, `/rest/api/3/issue/${encodeURIComponent(ideaKey)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [PROJECT_FIELD]: ari } }),
  });
}

export async function fetchGovernanceCandidates(): Promise<GovernanceCandidate[]> {
  const auth = credentials();
  const [options, page] = await Promise.all([fetchFieldOptions(auth), fetchActiveIdeas(auth)]);
  return (page.issues ?? [])
    .map((issue, index) => ({ candidate: normalizeIssue(issue, page.statuses ?? {}, options), index }))
    .sort((left, right) =>
      roadmapIndex(left.candidate.roadmap) - roadmapIndex(right.candidate.roadmap) || left.index - right.index)
    .map(({ candidate }) => candidate);
}

export async function createProjectForIdea(ideaKey: string): Promise<ProjectCreationResult> {
  const auth = credentials();

  // This re-fetch and field guard are the durable identity check. Project names are not identities.
  const activeIdeas = await fetchActiveIdeas(auth);
  const idea = activeIdeas.issues?.find((candidate) => candidate.key === ideaKey);
  if (!idea) throw new Error("This idea is not active in ZTK.");

  const existingProject = projectAri(idea.fields[PROJECT_FIELD]);
  if (existingProject) {
    return {
      projectAri: existingProject,
      projectName: typeof idea.fields.summary === "string" ? idea.fields.summary : "Existing project",
      created: false,
    };
  }

  type CreateResponse = {
    projects_create: { success: boolean; project?: { id?: string; name?: string; url?: string } };
  };
  const result = await graphqlRequest<CreateResponse>(
    auth,
    "CreateGovernanceProject",
    "mutation CreateGovernanceProject($input: TownsquareProjectsCreateInput!) { projects_create(input: $input) { success project { id name url } } }",
    {
      input: {
        containerId: PROJECT_CONTAINER_ID,
        name: typeof idea.fields.summary === "string" ? idea.fields.summary : ideaKey,
        accessLevel: "OPEN_VIEW",
      },
    },
  );
  const project = result.projects_create.project;
  if (!result.projects_create.success || !project?.id || !project.name) {
    throw new Error("Atlassian did not confirm project creation.");
  }

  await writeProjectToIdea(auth, ideaKey, project.id);
  return {
    projectAri: project.id,
    projectName: project.name,
    projectUrl: project.url,
    created: true,
  };
}

export async function searchProjectWorkItems(projectId: string, searchString: string): Promise<JiraWorkItem[]> {
  const auth = credentials();
  type SearchResponse = {
    projects_searchJiraWorkItemsToLink: {
      edges: Array<{
        node: {
          id: string;
          key: string;
          summary?: string;
          webUrl?: string;
          issueType?: { name?: string };
        };
      }>;
    };
  };
  const result = await graphqlRequest<SearchResponse>(
    auth,
    "SearchGovernanceProjectWorkItems",
    "query SearchGovernanceProjectWorkItems($projectId: ID!, $searchString: String!) { projects_searchJiraWorkItemsToLink(projectId: $projectId, searchString: $searchString, first: 20) { edges { node { id key summary webUrl issueType { name } } } } }",
    { projectId, searchString },
  );
  const normalizedQuery = searchString.toLowerCase();
  const queryTokens = normalizedQuery.split(/[^a-z0-9]+/).filter(Boolean);
  const items = await Promise.all(result.projects_searchJiraWorkItemsToLink.edges.map(async ({ node }) => {
    const summary = node.summary ?? "Untitled work item";
    const haystack = `${node.key} ${summary}`.toLowerCase();
    const matches = queryTokens.filter((token) => haystack.includes(token)).length;
    const exact = haystack.includes(normalizedQuery) ? 2 : 0;
    let parent: { id?: string; key?: string; summary?: string } | undefined;
    try {
      const issue = await atlassianRequest<{
        fields?: { parent?: { id?: string; key?: string; fields?: { summary?: string } } };
      }>(auth, `/rest/api/3/issue/${encodeURIComponent(node.key)}?fields=parent`);
      if (issue.fields?.parent) {
        parent = {
          id: issue.fields.parent.id,
          key: issue.fields.parent.key,
          summary: issue.fields.parent.fields?.summary,
        };
      }
    } catch {
      // Search results remain usable when optional parent enrichment fails.
    }
    return {
      id: node.id,
      key: node.key,
      summary,
      webUrl: node.webUrl ?? `${SITE_URL}/browse/${node.key}`,
      issueType: node.issueType?.name,
      parentKey: parent?.key,
      parentId: parent?.id,
      parentSummary: parent?.summary,
      score: exact + matches,
      recommendation: parent?.key
        ? `Parent Epic: ${parent.key}`
        : exact
          ? "Strong phrase match"
          : matches
            ? "Summary keyword match"
            : "Jira search match",
    } satisfies JiraWorkItem;
  }));
  return items.sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).slice(0, 5);
}

export async function linkIdeaWorkItem(ideaKey: string, workItemKey: string): Promise<void> {
  const auth = credentials();
  const issue = await atlassianRequest<{
    fields?: {
      issuelinks?: Array<{
        type?: { id?: string };
        inwardIssue?: { key?: string };
        outwardIssue?: { key?: string };
      }>;
    };
  }>(auth, `/rest/api/3/issue/${encodeURIComponent(ideaKey)}?fields=issuelinks`);
  const alreadyLinked = issue.fields?.issuelinks?.some((link) =>
    link.type?.id === ISSUE_LINK_TYPE_ID
    && (link.inwardIssue?.key === workItemKey || link.outwardIssue?.key === workItemKey));
  if (alreadyLinked) return;

  await atlassianRequest<unknown>(auth, "/rest/api/3/issueLink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: { id: ISSUE_LINK_TYPE_ID },
      inwardIssue: { key: ideaKey },
      outwardIssue: { key: workItemKey },
    }),
  });
}

export async function linkProjectWorkItem(projectId: string, workItemId: string) {
  const auth = credentials();
  type LinkResponse = {
    projects_addJiraWorkItemLink: {
      success: boolean;
      workItem?: { key?: string; summary?: string; webUrl?: string };
    };
  };
  const result = await graphqlRequest<LinkResponse>(
    auth,
    "LinkGovernanceProjectWorkItem",
    "mutation LinkGovernanceProjectWorkItem($input: TownsquareProjectsAddJiraWorkItemLinkInput!) { projects_addJiraWorkItemLink(input: $input) { success workItem { key summary webUrl } } }",
    {
      input: {
        projectId,
        workItemId,
        replaceCurrentWorkItemLink: false,
        replaceChildWorkItemLinks: false,
      },
    },
  );
  const workItem = result.projects_addJiraWorkItemLink.workItem;
  if (!result.projects_addJiraWorkItemLink.success || !workItem?.key) {
    throw new Error("Atlassian did not confirm the Jira work-item link.");
  }
  return {
    key: workItem.key,
    summary: workItem.summary ?? "",
    webUrl: workItem.webUrl ?? `${SITE_URL}/browse/${workItem.key}`,
  };
}
