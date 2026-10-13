export type CatalogFile = { id: string; name: string; mimeType: string; folders: string[] };
type Page = { files?: Omit<CatalogFile, "folders">[]; nextPageToken?: string };

/** Traverse only descendants of the authorized folder; never follow shortcuts. */
export async function collectDriveCatalog(root: string, list: (folder: string, token?: string) => Promise<Page>, maxPages = 60) {
  const queue = [{ id: root, folders: [] as string[], token: undefined as string | undefined }];
  const folders = new Set([root]);
  const files = new Map<string, CatalogFile>();
  let pages = 0;
  while (queue.length && pages < maxPages) {
    const current = queue.shift()!;
    const page = await list(current.id, current.token);
    pages++;
    for (const file of page.files ?? []) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        if (!folders.has(file.id)) {
          folders.add(file.id);
          queue.push({ id: file.id, folders: [...current.folders, file.name], token: undefined });
        }
      } else if (file.mimeType !== "application/vnd.google-apps.shortcut") {
        files.set(file.id, { ...file, folders: current.folders });
      }
    }
    // Round-robin pagination prevents a large folder starving other folders.
    if (page.nextPageToken) queue.push({ ...current, token: page.nextPageToken });
  }
  return { files: [...files.values()], truncated: queue.length > 0 };
}

export function belongsToProject(file: CatalogFile, website?: string) {
  if (!website) return true;
  const host = new URL(website).hostname.replace(/^www\./, "").split(".")[0];
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // Exact folder/domain label only: an unrelated filename is not project evidence.
  return file.folders.some(folder => normalize(folder) === normalize(host));
}
