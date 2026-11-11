import { env } from "../../lib/runtime";
import { processBrandAgentSchedules } from "../../lib/brand-agent-scheduler";
import { repairPendingStories } from "../../lib/repair-story-format";
import { addDays, localDate } from "../../lib/autopilot";

declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (request: Request) => {
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return;
  const hasProviderAI = Boolean(Netlify.env.get("OPENAI_API_KEY") && Netlify.env.get("OPENAI_BASE_URL"));
  const hasGatewayAI = Boolean(Netlify.env.get("NETLIFY_AI_GATEWAY_KEY") && Netlify.env.get("NETLIFY_AI_GATEWAY_URL"));
  console.warn("Social Studio agent runtime", JSON.stringify({ db: Boolean(env.DB), bucket: Boolean(env.BUCKET), hasProviderAI, hasGatewayAI }));
  if (!env.DB || !env.BUCKET) return;
  await repairPendingStories(env.DB, env.BUCKET);
  const priorityBrands = ["D’Neyla", "Bahia Investment", "Manglar"];
  const fillThrough = addDays(localDate(Date.now()), 30);
  const results = await Promise.allSettled([
    ...priorityBrands.map(async brandName => {
      for (let i = 0; i < 5; i++) {
        await processBrandAgentSchedules(env.DB!, { brandName, maxLocalDate: fillThrough });
      }
    }),
    processBrandAgentSchedules(env.DB, { excludeNames: priorityBrands }),
  ]);
  console.warn("Social Studio 30-day autofill window", fillThrough);
  for (const result of results) if (result.status === "rejected") console.error("Social Studio scheduler branch failed", result.reason);
};
