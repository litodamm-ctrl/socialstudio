import { env } from "@/lib/runtime";

export async function ensureCreativeJobs() {
  if (!env.DB) throw new Error("Configura Cloudflare D1.");
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS creative_jobs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
  )`).run();
  return env.DB;
}

export async function launchBackground(name: "creative-background" | "publish-background", body: unknown = {}) {
  const origin = process.env.SITE_ORIGIN;
  const secret = process.env.CRON_SECRET;
  if (!origin || !secret) throw new Error("Configura SITE_ORIGIN y CRON_SECRET en Netlify.");
  const response = await fetch(new URL(`/.netlify/functions/${name}`, origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) throw new Error("Netlify no pudo iniciar la tarea en segundo plano.");
}
