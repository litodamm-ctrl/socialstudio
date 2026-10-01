import { launchBackground } from "@/lib/netlify-jobs";
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  try { await launchBackground("publish-background"); return Response.json({ queued: true }, { status: 202 }); }
  catch { return Response.json({ error: "No se pudo iniciar la publicación." }, { status: 503 }); }
}
