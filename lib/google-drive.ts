import type { ReferenceUsage } from "@/lib/reference-usage";
import { rotateReferences } from "@/lib/creative-references";
import { collectDriveCatalog, belongsToProject } from "@/lib/drive-catalog";

type DriveFile = { id: string; name: string; mimeType: string };
type DriveContent = Array<Record<string, string>>;

export async function loadGoogleDriveMaterials(
  db: D1Database,
  ownerId: string,
  brandId: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
  decryptToken: (token: string) => Promise<string>,
  rotationSeed = new Date().toISOString().slice(0, 10),
  usage?: ReferenceUsage,
  projectWebsite?: string,
): Promise<{ text: string; content: DriveContent }> {
  if (!clientId || !clientSecret) return { text: "", content: [] };
  const brand = await db.prepare("SELECT drive_folder_id, drive_refresh_token FROM brand_registry WHERE owner_id = ? AND id = ? AND active = 1")
    .bind(ownerId, brandId).first<{ drive_folder_id: string; drive_refresh_token: string | null }>();
  if (!brand?.drive_folder_id || !brand.drive_refresh_token) return { text: "", content: [] };
  const refreshToken = await decryptToken(brand.drive_refresh_token);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_description ?? "No se pudo renovar el acceso de Google Drive.");
  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.searchParams.set("q", `'${brand.drive_folder_id}' in parents and trashed = false`);
  listUrl.searchParams.set("pageSize", "100");
  listUrl.searchParams.set("orderBy", "modifiedTime desc");
  listUrl.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
  listUrl.searchParams.set("supportsAllDrives", "true");
  listUrl.searchParams.set("includeItemsFromAllDrives", "true");
  const deadline = Date.now() + 40_000;
  const catalog = await collectDriveCatalog(brand.drive_folder_id, async (folder, token) => {
    if (Date.now() >= deadline) throw new Error("La carpeta de Drive es demasiado grande para leerla en una generación. Divide los materiales por marca/proyecto.");
    listUrl.searchParams.set("q", `'${folder.replace(/['\\]/g, "")}' in parents and trashed = false`);
    if (token) listUrl.searchParams.set("pageToken", token); else listUrl.searchParams.delete("pageToken");
    const filesResponse = await fetch(listUrl, { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const filesData = await filesResponse.json() as { files?: DriveFile[]; nextPageToken?: string; error?: { message?: string } };
    if (!filesResponse.ok) throw new Error(filesData.error?.message ?? "No se pudieron leer los archivos de Drive.");
    return filesData;
  });
  if (catalog.truncated) throw new Error("Drive supera el límite de exploración. Conecta una carpeta más específica para evitar ignorar material.");
  const files = catalog.files.filter(file => belongsToProject(file, projectWebsite));
  const supported = files.filter(file => file.mimeType.startsWith("text/") || ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.mimeType));
  const content: DriveContent = [];
  const notes: string[] = [];
  let totalBytes = 0;
  const ranked = usage ? usage.rank(supported, file => `drive:${file.id}`) : rotateReferences(supported, rotationSeed, supported.length);
  // Documents must not crowd photographs out of the reference budget.
  const selected = [...ranked.filter(file => file.mimeType.startsWith("image/")).slice(0, 8), ...ranked.filter(file => !file.mimeType.startsWith("image/")).slice(0, 2)];
  for (const file of selected) {
    if (totalBytes > 9 * 1024 * 1024) break;
    try {
      if (file.mimeType === "application/vnd.google-apps.document" || file.mimeType === "application/vnd.google-apps.spreadsheet") {
        const mime = file.mimeType.endsWith("spreadsheet") ? "text/csv" : "text/plain";
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`);
        url.searchParams.set("mimeType", mime);
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        if (response.ok) notes.push(`${file.name}: ${(await readText(response, 7000)).slice(0, 7000)}`);
      } else if (["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.mimeType)) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
        url.searchParams.set("alt", "media");
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        if (!response.ok) continue;
        const bytes = await readBytes(response, Math.min(5 * 1024 * 1024, 10 * 1024 * 1024 - totalBytes));
        if (!bytes) continue;
        totalBytes += bytes.length;
        const base64 = bytesToBase64(bytes);
        if (file.mimeType.startsWith("image/")) {
          content.push({ type: "input_image", image_url: `data:${file.mimeType};base64,${base64}`, detail: "high", source_key: `drive:${file.id}`, source_name: file.name, source_role: /logo|identidad/i.test(file.name) ? "logo" : "product" });
        }
        else content.push({ type: "input_file", filename: file.name.slice(0, 100) || "referencia.pdf", file_data: `data:application/pdf;base64,${base64}` });
      } else if (file.mimeType.startsWith("text/")) {
        const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
        url.searchParams.set("alt", "media");
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        if (response.ok) notes.push(`${file.name}: ${(await readText(response, 7000)).slice(0, 7000)}`);
      }
    } catch (error) {
      console.warn("A Drive source file could not be included", file.name, error instanceof Error ? error.message.slice(0, 160) : "unknown error");
    }
  }
  return { text: notes.join("\n\n").slice(0, 16_000), content };
}

async function readText(response: Response, maxBytes: number) {
  const bytes = await readBytes(response, maxBytes, true);
  return bytes ? new TextDecoder().decode(bytes).replace(/\s+/g, " ").trim() : "";
}

async function readBytes(response: Response, maxBytes: number, truncate = false) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > maxBytes - total) {
      await reader.cancel();
      if (!truncate) return null;
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    const part = value;
    chunks.push(part); total += part.length;
    if (part.length !== value.length) break;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
