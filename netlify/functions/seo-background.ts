import { env } from "../../lib/runtime";
import { ensureSeo, runSeo, processSeoSchedules } from "../../lib/seo";

declare const Netlify: { env: { get(name: string): string | undefined } };
export default async (request: Request) => {
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
  if (!env.DB) return new Response(null, { status: 503 });
  await ensureSeo(env.DB);
  const input = await request.json().catch(() => ({})) as { runId?: string };
  if (input.runId && /^[a-f0-9-]{36}$/i.test(input.runId)) await runSeo(env.DB, input.runId);
  else await processSeoSchedules(env.DB);
};

export const config = { background: true };
