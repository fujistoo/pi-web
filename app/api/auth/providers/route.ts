import { homedir } from "node:os";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  const services = await createAgentSessionServices({ cwd: homedir(), agentDir: getAgentDir() });
  const inputs = await collectProviderListingInputs(services.modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
