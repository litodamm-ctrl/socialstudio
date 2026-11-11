import { env } from "../../lib/runtime";
import { addDays, localDate } from "../../lib/autopilot";

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (request: Request) => {
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}` || !env.DB) return;
  const start = addDays(localDate(Date.now()), 1);
  const end = addDays(localDate(Date.now()), 60);
  const summary = await env.DB.prepare(`SELECT b.name, s.status, COUNT(*) AS total
    FROM autopilot_slots s
    JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
    WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
      AND s.local_date >= ? AND s.local_date <= ?
    GROUP BY b.name, s.status
    ORDER BY b.name, s.status`).bind(start, end).all<{name:string;status:string;total:number}>();
  console.warn("Social Studio 60-day status", start, end, JSON.stringify(summary.results ?? []));
};
