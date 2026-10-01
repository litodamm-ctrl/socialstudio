import { env } from "@/lib/runtime";
import { ensureCreativeJobs, launchBackground } from "@/lib/netlify-jobs";

export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.OPENAI_API_KEY) return Response.json({ error: "Configura OPENAI_API_KEY en Netlify." }, { status: 503 });
  try {
    const payload = await request.text();
    if (payload.length > 5000) return Response.json({ error: "El brief es demasiado largo." }, { status: 400 });
    JSON.parse(payload);
    const db = await ensureCreativeJobs();
    const jobId = crypto.randomUUID();
    await db.prepare("INSERT INTO creative_jobs (id, owner_id, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(jobId, owner, payload, Date.now()).run();
    try { await launchBackground("creative-background", { jobId }); }
    catch (error) {
      await db.prepare("UPDATE creative_jobs SET status = 'failed', result = ? WHERE id = ?")
        .bind(JSON.stringify({ error: "No se pudo iniciar la generación." }), jobId).run();
      throw error;
    }
    return Response.json({ jobId, status: "pending" }, { status: 202 });
  } catch {
    return Response.json({ error: "No se pudo iniciar el agente. Revisa D1, SITE_ORIGIN, CRON_SECRET y las funciones de Netlify." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  try {
    const db = await ensureCreativeJobs();
    const job = await db.prepare("SELECT status, result, created_at FROM creative_jobs WHERE id = ? AND owner_id = ?")
      .bind(new URL(request.url).searchParams.get("jobId") ?? "", owner)
      .first<{ status: string; result: string | null; created_at: number }>();
    if (!job) return Response.json({ error: "Tarea no encontrada." }, { status: 404 });
    if (['pending', 'processing'].includes(job.status) && Date.now() - job.created_at > 7 * 60_000) {
      return Response.json({ status: "failed", error: "La generación se interrumpió. Revisa las funciones de Netlify." });
    }
    return Response.json({ ...(job.result ? JSON.parse(job.result) : {}), status: job.status }, { headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "No se pudo consultar la generación." }, { status: 503 }); }
}
