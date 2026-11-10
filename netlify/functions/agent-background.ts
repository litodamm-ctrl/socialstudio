import { env } from "../../lib/runtime";
import { processBrandAgentSchedules } from "../../lib/brand-agent-scheduler";
import { repairPendingStories } from "../../lib/repair-story-format";

declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (request: Request) => {
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return;
  const hasProviderAI = Boolean(Netlify.env.get("OPENAI_API_KEY") && Netlify.env.get("OPENAI_BASE_URL"));
  const hasGatewayAI = Boolean(Netlify.env.get("NETLIFY_AI_GATEWAY_KEY") && Netlify.env.get("NETLIFY_AI_GATEWAY_URL"));
  console.info("Social Studio agent runtime", JSON.stringify({ db: Boolean(env.DB), bucket: Boolean(env.BUCKET), hasProviderAI, hasGatewayAI }));
  if (!env.DB || !env.BUCKET || (!hasProviderAI && !hasGatewayAI)) return;
  await repairPendingStories(env.DB, env.BUCKET);
  await processBrandAgentSchedules(env.DB);
};
