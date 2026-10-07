import { env } from "../../lib/runtime";
import { processBrandAgentSchedules } from "../../lib/brand-agent-scheduler";
import { repairPendingStories } from "../../lib/repair-story-format";

declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (request: Request) => {
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return;
  if (!env.DB || !env.BUCKET || !env.OPENAI_API_KEY) return;
  await repairPendingStories(env.DB, env.BUCKET);
  await processBrandAgentSchedules(env.DB);
};
