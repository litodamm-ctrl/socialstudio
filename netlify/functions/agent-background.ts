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
  const today = localDate(Date.now());
  const fillStart = addDays(today, 1);
  const fillThrough = addDays(today, 60);
  const ranges = [
    { from: 1, to: 15 },
    { from: 16, to: 30 },
    { from: 31, to: 45 },
    { from: 46, to: 60 },
  ];
  const beforeSummary = await env.DB.prepare(`SELECT b.name, s.status, COUNT(*) AS total
    FROM autopilot_slots s
    JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
    WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
      AND s.local_date >= ? AND s.local_date <= ?
    GROUP BY b.name, s.status
    ORDER BY b.name, s.status`).bind(fillStart, fillThrough).all<{name:string;status:string;total:number}>();
  console.warn("Social Studio 60-day autofill progress", JSON.stringify(beforeSummary.results ?? []));
  const results = await Promise.allSettled([
    ...priorityBrands.flatMap(brandName => ranges.map(({ from, to }) => (async () => {
      const minLocalDate = addDays(today, from);
      const maxLocalDate = addDays(today, to);
      for (let i = 0; i < 18; i++) {
        await processBrandAgentSchedules(env.DB!, {
          brandName,
          minLocalDate,
          maxLocalDate,
          workerKey: `${brandName}:days-${from}-${to}`,
        });
      }
    })())),
    processBrandAgentSchedules(env.DB, { excludeNames: priorityBrands }),
  ]);
  console.warn("Social Studio 60-day autofill window", fillStart, fillThrough);
  for (const result of results) if (result.status === "rejected") console.error("Social Studio scheduler branch failed", result.reason);

  const summary = await env.DB.prepare(`SELECT b.name, s.status, COUNT(*) AS total
    FROM autopilot_slots s
    JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
    WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
      AND s.local_date >= ? AND s.local_date <= ?
    GROUP BY b.name, s.status
    ORDER BY b.name, s.status`).bind(fillStart, fillThrough).all<{name:string;status:string;total:number}>();
  console.warn("Social Studio 60-day autofill summary", JSON.stringify(summary.results ?? []));
};
