import { env } from "@/lib/runtime";

export async function GET(request: Request) {
  if (!request.headers.get("oai-authenticated-user-id")) {
    return Response.json({ error: "Inicia sesión para revisar el agente creativo." }, { status: 401 });
  }
  const required = ["OPENAI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SITE_ORIGIN", "CRON_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_TOKEN_ENCRYPTION_KEY"];
  return Response.json({ configured: Boolean(env.OPENAI_API_KEY && env.DB && env.BUCKET), missing: required.filter(key => !process.env[key]) });
}
