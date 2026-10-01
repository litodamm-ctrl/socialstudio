import { env } from "../../lib/runtime";
import { processDueInstagramPublications } from "../../lib/instagram-publisher";
import { processBrandAgentSchedules } from "../../lib/brand-agent-scheduler";

export default async (request: Request) => {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return;
  if (!env.DB) throw new Error("Configura Cloudflare D1.");
  await processDueInstagramPublications(env);
  if (env.OPENAI_API_KEY) await processBrandAgentSchedules(env.DB);
};
export const config = { background: true };
