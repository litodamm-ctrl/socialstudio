/** Save the currently entered folder before starting OAuth; surface server errors in the app. */
export async function prepareDriveConnection(id: string, folder: string, send: typeof fetch = fetch): Promise<string> {
  let url: URL;
  try { url = new URL(folder.trim()); }
  catch { throw new Error("Pega el enlace de la carpeta de Google Drive antes de conectar."); }
  const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "drive.google.com" || !match) {
    throw new Error("Usa el enlace de una carpeta de Google Drive, no el de un archivo.");
  }
  const endpoint = `/api/brands/${encodeURIComponent(id)}`;
  async function read(response: Response) {
    if (response.redirected || response.status === 401) throw new Error("Tu sesión expiró. Inicia sesión de nuevo para conectar Google Drive.");
    const data = await response.json().catch(() => null) as { error?: string; url?: string } | null;
    if (!response.ok || !data) throw new Error(data?.error || "No se pudo conectar Google Drive. Intenta de nuevo.");
    return data;
  }
  await read(await send(endpoint, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driveFolderUrl: `https://drive.google.com/drive/folders/${match[1]}` }),
  }));
  const data = await read(await send(`${endpoint}/drive/connect?format=json`, { cache: "no-store" }));
  if (!data.url || !data.url.startsWith("https://accounts.google.com/")) throw new Error("Google no devolvió un enlace de conexión válido.");
  return data.url;
}
