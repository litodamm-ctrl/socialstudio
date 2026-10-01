import { env } from "@/lib/runtime";

export async function GET(request: Request) {
  if (!request.headers.get("oai-authenticated-user-id")) {
    return Response.json({ error: "Inicia sesión para revisar el agente creativo." }, { status: 401 });
  }
  return Response.json({ configured: Boolean(env.OPENAI_API_KEY) });
}
