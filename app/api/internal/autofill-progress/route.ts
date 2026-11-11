import { env } from "@/lib/runtime";
import { addDays, localDate } from "@/lib/autopilot";

export async function GET() {
  if (!env.DB) return Response.json({ error: "DB unavailable" }, { status: 503 });
  const start = addDays(localDate(Date.now()), 1);
  const end = addDays(localDate(Date.now()), 60);
  const rows = await env.DB.prepare(`SELECT b.name, s.status, COUNT(*) AS total
    FROM autopilot_slots s
    JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
    WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
      AND s.local_date >= ? AND s.local_date <= ?
    GROUP BY b.name, s.status
    ORDER BY b.name, s.status`).bind(start, end).all<{name:string;status:string;total:number}>();
  const failures = await env.DB.prepare(`SELECT b.name, s.local_date, s.media_type, s.attempts, s.last_error
    FROM autopilot_slots s
    JOIN brand_registry b ON b.id=s.brand_id AND b.owner_id=s.owner_id
    WHERE b.name IN ('D’Neyla','Bahia Investment','Manglar')
      AND s.local_date >= ? AND s.local_date <= ?
      AND s.status = 'failed'
    ORDER BY b.name, s.local_date, s.media_type`).bind(start, end).all<{name:string;local_date:string;media_type:string;attempts:number;last_error:string}>();
  return Response.json({ start, end, rows: rows.results ?? [], failures: failures.results ?? [] }, { headers: { "cache-control": "no-store" } });
}
