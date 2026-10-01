import { ensureCreativeJobs } from "../../lib/netlify-jobs";
import { POST as generate } from "../../lib/generate-creative";

export default async (request: Request) => {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return;
  const { jobId } = await request.json() as { jobId: string };
  const db = await ensureCreativeJobs();
  const job = await db.prepare("UPDATE creative_jobs SET status = 'processing' WHERE id = ? AND status = 'pending' RETURNING owner_id, payload")
    .bind(jobId).first<{ owner_id: string; payload: string }>();
  if (!job) return;
  try {
    const response = await generate(new Request("https://internal/api/agent/generate", {
      method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": job.owner_id }, body: job.payload,
    }));
    const result = await response.text();
    await db.prepare("UPDATE creative_jobs SET status = ?, result = ? WHERE id = ?")
      .bind(response.ok ? "completed" : "failed", result, jobId).run();
  } catch {
    await db.prepare("UPDATE creative_jobs SET status = 'failed', result = ? WHERE id = ?")
      .bind(JSON.stringify({ error: "La generación se interrumpió. Intenta nuevamente." }), jobId).run();
  }
};
export const config = { background: true };
