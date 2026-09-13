export const AGENT_WORKER_PROTOCOL_VERSION = 1;
export const AGENT_WORKER_DESCRIPTOR_FILE = "pi-web-agent-worker.json";

export interface AgentWorkerDescriptor {
  version: typeof AGENT_WORKER_PROTOCOL_VERSION;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface AgentWorkerStateResponse {
  running: boolean;
  state?: Record<string, unknown>;
  worker?: {
    pid: number;
    generation: string;
  };
}

export interface AgentWorkerEventRecord {
  sequence: number;
  event: Record<string, unknown>;
}
