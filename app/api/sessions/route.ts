import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getExistingAgentWorkerInfos } from "@/lib/agent-worker-client";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, workerState] = await Promise.all([
      persistedSessionsPromise,
      (async () => {
        try {
          const response = await getExistingAgentWorkerInfos();
          if (!response) return null;
          if (!response.ok) return null;
          return await response.json() as {
            sessions?: import("@/lib/types").SessionInfo[];
            runningSessionIds?: string[];
            completionNotificationSuppressedSessionIds?: string[];
          };
        } catch {
          return null;
        }
      })(),
    ]);
    const localState = getRpcSessionInfos();
    const runtimeSessions = mergeSessionLists(workerState?.sessions ?? [], localState);
    const sessions = mergeSessionLists(persistedSessions, await attachSessionProjectInfo(runtimeSessions));
    const runningSessionIds = new Set([
      ...(workerState?.runningSessionIds ?? []),
      ...getRunningRpcSessionIds(),
    ]);
    const completionNotificationSuppressedSessionIds = new Set([
      ...(workerState?.completionNotificationSuppressedSessionIds ?? []),
      ...getCompletionNotificationSuppressedRpcSessionIds(),
    ]);
    return jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: [...runningSessionIds],
        completionNotificationSuppressedSessionIds: [...completionNotificationSuppressedSessionIds],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
