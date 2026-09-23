import { TeamFeatureStore, type TeamMessage } from "./team-state";

export interface TeamMessageTransport {
  deliver(message: TeamMessage): void | Promise<void>;
}

/** Persists a pending direct message before invoking its delivery transport. */
export async function sendTeamMessage(
  store: TeamFeatureStore,
  input: { id?: string; sender_id: string; recipient_id: string; body: string },
  transport: TeamMessageTransport,
): Promise<TeamMessage> {
  const pending = store.createDirectMessage(input);
  try {
    await transport.deliver(pending);
    return store.markMessageDelivery(pending.id, "delivered");
  } catch (error) {
    return store.markMessageDelivery(
      pending.id,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
