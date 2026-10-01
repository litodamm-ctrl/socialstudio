import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { randomUrlSafe } from "@/lib/meta";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para conectar Google Drive." }, { status: 401 });
  if (!env.DB || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.json({ error: "Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET antes de conectar Drive." }, { status: 503 });
  }
  const { id } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const brand = await env.DB.prepare("SELECT id, drive_folder_id FROM brand_registry WHERE id = ? AND owner_id = ? AND active = 1")
      .bind(id, ownerId).first<{ id: string; drive_folder_id: string }>();
    if (!brand) return Response.json({ error: "Selecciona primero una marca activa." }, { status: 404 });
    if (!brand.drive_folder_id) return Response.json({ error: "Pega primero el enlace a la carpeta de Drive de esta marca y guarda el perfil." }, { status: 400 });
    const state = randomUrlSafe();
    const now = Date.now();
    await env.DB.prepare("DELETE FROM brand_drive_states WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO brand_drive_states (state, owner_id, brand_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(state, ownerId, id, now + 10 * 60_000, now).run();
    const redirectUri = new URL("/api/brands/drive/callback", request.url).toString();
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "https://www.googleapis.com/auth/drive.readonly");
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    auth.searchParams.set("include_granted_scopes", "true");
    auth.searchParams.set("state", state);
    return Response.redirect(auth.toString(), 302);
  } catch (error) {
    console.error("Unable to start Google Drive authorization", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo iniciar la conexión con Google Drive." }, { status: 503 });
  }
}
