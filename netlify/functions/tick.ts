import { launchBackground } from "../../lib/netlify-jobs";
import { env } from "../../lib/runtime";
import { addDays, localDate } from "../../lib/autopilot";

export default async () => {
  if (env.DB) {
    const start = addDays(localDate(Date.now()), 1);
    const end = addDays(localDate(Date.now()), 60);
    const summary = await env.DB.prepare(`SELECT b.name, s.status, COUNT(*) AS total
      FROM autopilot_slots s
      JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
      WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
        AND s.local_date >= ? AND s.local_date <= ?
      GROUP BY b.name, s.status
      ORDER BY b.name, s.status`).bind(start, end).all<{name:string;status:string;total:number}>();
    console.warn("Social Studio 60-day tick status", start, end, JSON.stringify(summary.results ?? []));
  }
  const results = await Promise.allSettled([launchBackground("publish-background"), launchBackground("agent-background")]);
  for (const result of results) if (result.status === "rejected") console.error("No se pudo iniciar una tarea programada", result.reason);
};
export const config = { schedule: "* * * * *" };
