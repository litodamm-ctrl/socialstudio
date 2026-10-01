import { env } from "@/lib/runtime";
import { brandInitials, DEFAULT_BRANDS, ensureDefaultBrands } from "@/lib/brands";

type BrandRow = {
  id: string; name: string; handle: string; color: string; initials: string; active: number;
  brand_essence: string; website_url: string; drive_folder_url: string; auto_schedule: number;
  auto_crosspost: number; posting_days: string; preferred_time: string;
  drive_connected: number;
};

function currentUser(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function serialize(row: BrandRow) {
  let postingDays: number[] = [2, 4, 6];
  try {
    const parsed: unknown = JSON.parse(row.posting_days);
    if (Array.isArray(parsed)) postingDays = parsed.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
  } catch { /* keep default days */ }
  return {
    id: row.id, name: row.name, handle: row.handle, color: row.color, initials: row.initials,
    active: Boolean(row.active), essence: row.brand_essence, websiteUrl: row.website_url,
    driveFolderUrl: row.drive_folder_url, driveConnected: Boolean(row.drive_connected), autoSchedule: Boolean(row.auto_schedule), autoCrosspost: Boolean(row.auto_crosspost),
    postingDays, preferredTime: row.preferred_time,
  };
}

export async function GET(request: Request) {
  const ownerId = currentUser(request);
  if (!ownerId) return Response.json({ error: "Inicia sesión para ver tus marcas." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Las marcas no están disponibles todavía." }, { status: 503 });
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const result = await env.DB.prepare("SELECT id, name, handle, color, initials, active, brand_essence, website_url, drive_folder_url, auto_schedule, auto_crosspost, posting_days, preferred_time, CASE WHEN drive_refresh_token IS NULL THEN 0 ELSE 1 END AS drive_connected FROM brand_registry WHERE owner_id = ? ORDER BY created_at, name")
      .bind(ownerId).all<BrandRow>();
    const all = (result.results ?? []).map(serialize);
    return Response.json({ brands: all.filter((item) => item.active), archivedBrands: all.filter((item) => !item.active) });
  } catch (error) {
    console.error("Unable to load brand registry", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudieron cargar las marcas." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const ownerId = currentUser(request);
  if (!ownerId) return Response.json({ error: "Inicia sesión para registrar una marca." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Las marcas no están disponibles todavía." }, { status: 503 });
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "Revisa los datos de la marca." }, { status: 400 }); }
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const handle = typeof input.handle === "string" ? input.handle.trim().replace(/^@+/, "").replace(/[^\p{L}\p{N}._]/gu, "").slice(0, 40) : "";
  if (name.length < 2 || name.length > 60) return Response.json({ error: "El nombre debe tener entre 2 y 60 caracteres." }, { status: 400 });
  if (typeof input.handle === "string" && input.handle.trim() && !handle) return Response.json({ error: "El usuario de Instagram no es válido." }, { status: 400 });
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const duplicate = await env.DB.prepare("SELECT id FROM brand_registry WHERE owner_id = ? AND lower(name) = lower(?)")
      .bind(ownerId, name).first<{ id: string }>();
    if (duplicate) return Response.json({ error: "Ya existe una marca con ese nombre." }, { status: 409 });
    const id = crypto.randomUUID();
    const now = Date.now();
    const color = DEFAULT_BRANDS[(name.length + name.codePointAt(0)!) % DEFAULT_BRANDS.length].color;
    const initials = brandInitials(name) || "M";
    await env.DB.prepare("INSERT INTO brand_registry (id, owner_id, name, handle, color, initials, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ownerId, name, handle ? `@${handle}` : "", color, initials, now, now).run();
    return Response.json({ brand: { id, name, handle: handle ? `@${handle}` : "", color, initials, active: true, essence: "", websiteUrl: "", driveFolderUrl: "", driveConnected: false, autoSchedule: false, autoCrosspost: false, postingDays: [2, 4, 6], preferredTime: "18:00" } }, { status: 201 });
  } catch (error) {
    console.error("Unable to add brand", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo registrar la marca." }, { status: 503 });
  }
}
