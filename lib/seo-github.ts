import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type * as TypeScript from "typescript";
import { analyzeSeo } from "@/lib/seo-audit";

export type SeoGithubTarget = { url: string; repository: string; branch: string; path: string };
type PullRequest = { url: string; number: number; branch: string };
type SeoMetadata = { title: string; description: string };
type JsonObject = Record<string, unknown>;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_API_BYTES = 24 * 1024 * 1024;
const NEXT_ROOT_PATHS = new Set(["app/layout.tsx", "src/app/layout.tsx", "app/page.tsx", "src/app/page.tsx"]);
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function githubConfigured(): boolean {
  return Boolean(process.env.SEO_GITHUB_TOKEN?.trim());
}

function canonicalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) {
    throw new Error("La URL de destino de GitHub debe ser una web pública HTTPS configurada.");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("La URL de destino de GitHub no es válida."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || /^https:\/\/[^/]*@/i.test(value)
    || url.port || !host.includes(".") || isIP(host) || host.includes(":")
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error("La URL de destino de GitHub debe usar HTTPS público, sin credenciales ni puertos personalizados.");
  }
  url.hash = "";
  return url.href;
}

function validateTarget(value: unknown): SeoGithubTarget {
  const item = object(value);
  if (Object.keys(item).some(key => !["url", "repository", "branch", "path"].includes(key))) {
    throw new Error("Los destinos de GitHub solo aceptan URL, repositorio, rama y ruta del archivo; nunca credenciales.");
  }
  const { repository, branch, path } = item;
  if (typeof repository !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1]) || repository.endsWith(".git")) {
    throw new Error("El repositorio de GitHub debe tener el formato propietario/repositorio, sin URL ni credenciales.");
  }
  if (typeof branch !== "string" || branch.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch)
    || branch.includes("..") || branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
    || branch === "HEAD" || branch.startsWith("refs/") || branch.startsWith("seo-studio/")) {
    throw new Error("Elige una rama de origen válida fuera del prefijo reservado seo-studio/.");
  }
  if (typeof path !== "string" || path.length > 512 || (!/\.html$/i.test(path) && !NEXT_ROOT_PATHS.has(path)) || path.split("/").length > 20
    || path.split("/").some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part.includes(".."))) {
    throw new Error("La ruta debe ser un archivo .html relativo o app/layout.tsx, app/page.tsx, src/app/layout.tsx o src/app/page.tsx, sin saltos de directorio, carpetas ocultas ni credenciales.");
  }
  return { url: canonicalUrl(item.url), repository: repository.toLowerCase(), branch, path };
}

/** The caller owns authorization/persistence. Pass only that owner's configured URLs. */
export function parseGithubTargets(value: unknown, urls: string[]): SeoGithubTarget[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error("Configura una lista de hasta 10 destinos de GitHub.");
  const configured = new Set(urls.map(canonicalUrl));
  const seen = new Set<string>();
  return value.map(item => {
    const target = validateTarget(item);
    if (!configured.has(target.url)) throw new Error("Cada URL de destino de GitHub debe coincidir exactamente con una web configurada.");
    if (seen.has(target.url)) throw new Error("Las URL de destino de GitHub deben ser únicas después de normalizarlas.");
    seen.add(target.url);
    return target;
  });
}

function metadata(value: string, limit: number, label: string): void {
  if (typeof value !== "string" || !value.trim() || [...value].length > limit
    || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`${label} debe contener entre 1 y ${limit} caracteres de texto, sin caracteres de control.`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function validateSource(source: string): void {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
    || /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(source) || Buffer.from(source, "utf8").toString("utf8") !== source) {
    throw new Error("El archivo de origen debe ser texto UTF-8 de hasta 16 MiB.");
  }
}

function nextAmbiguous(): never {
  throw new Error("Los metadatos de Next.js son ambiguos o dinámicos. Usa un único export const metadata con título y descripción literales, o abreviados mediante const title y const description literales de nivel superior, sin generateMetadata.");
}

/** Parse only: never evaluate, transpile or reprint the user's source. */
export async function updateNextSeoMetadata(source: string, title: string, description: string): Promise<string> {
  return (await nextMetadataPlan(source, title, description)).updated;
}

async function nextMetadataPlan(source: string, title: string, description: string): Promise<{ updated: string; current: SeoMetadata }> {
  metadata(title, 150, "El título SEO");
  metadata(description, 320, "La descripción SEO");
  validateSource(source);
  let ts: typeof TypeScript;
  try { ts = await import("typescript"); }
  catch { throw new Error("No se pudo cargar TypeScript. Instala typescript como dependencia de producción para actualizar metadatos de Next.js."); }
  let file: TypeScript.SourceFile;
  try { file = ts.createSourceFile("seo-root.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
  catch { return nextAmbiguous(); }
  const diagnostics = (file as TypeScript.SourceFile & { parseDiagnostics: readonly TypeScript.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length) return nextAmbiguous();

  const bindings = new Map<string, number>();
  const constants = new Map<string, TypeScript.VariableDeclaration>();
  const candidates: TypeScript.VariableDeclaration[] = [];
  const bind = (name: TypeScript.BindingName) => {
    if (ts.isIdentifier(name)) bindings.set(name.text, (bindings.get(name.text) ?? 0) + 1);
    else for (const part of name.elements) if (ts.isBindingElement(part)) bind(part.name);
  };
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);
      const modifiers = ts.getModifiers(statement) ?? [];
      const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const ambient = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
      for (const declaration of statement.declarationList.declarations) {
        bind(declaration.name);
        if (ts.isIdentifier(declaration.name)) {
          if (isConst && !ambient) constants.set(declaration.name.text, declaration);
          if (declaration.name.text === "metadata" && exported && isConst && !ambient) candidates.push(declaration);
        }
      }
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) bind(clause.name);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name);
        else for (const element of clause.namedBindings.elements) bind(element.name);
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      if (statement.name) bind(statement.name);
    }
    // Star re-exports could introduce generateMetadata without an explicit name.
    if (ts.isExportDeclaration(statement) && (!statement.exportClause || !ts.isNamedExports(statement.exportClause)
      || statement.exportClause.elements.some(element => ["metadata", "generateMetadata"].includes(element.name.text)))) return nextAmbiguous();
  }
  if (candidates.length !== 1 || bindings.get("metadata") !== 1) return nextAmbiguous();
  const declaration = candidates[0];
  if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) return nextAmbiguous();

  // Escaping/passing/mutating metadata after declaration would invalidate literal
  // edits. Inspect AST identifiers, not comments or strings containing fake code.
  const nodes: TypeScript.Node[] = [file];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (ts.isIdentifier(node) && (node.text === "generateMetadata" || (node.text === "metadata" && node !== declaration.name))) return nextAmbiguous();
    ts.forEachChild(node, child => { nodes.push(child); });
  }

  const literals = new Map<string, TypeScript.StringLiteral>();
  const shorthandNames = new Set<string>();
  const names = new Set<string>();
  for (const property of declaration.initializer.properties) {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return nextAmbiguous();
    const name = property.name.text;
    if (names.has(name)) return nextAmbiguous();
    names.add(name);
    if (name !== "title" && name !== "description") continue;
    let literal: TypeScript.Expression | undefined;
    if (ts.isPropertyAssignment(property)) literal = property.initializer;
    else {
      if (property.objectAssignmentInitializer || bindings.get(name) !== 1) return nextAmbiguous();
      const constant = constants.get(name);
      // A shorthand binding must be initialized before metadata is evaluated.
      if (!constant || constant.pos >= declaration.pos) return nextAmbiguous();
      literal = constant.initializer;
      shorthandNames.add(name);
    }
    if (!literal || !ts.isStringLiteral(literal)) return nextAmbiguous();
    literals.set(name, literal);
  }
  if (literals.size !== 2) return nextAmbiguous();
  const assignments: TypeScript.Node[] = [file];
  while (assignments.length) {
    const node = assignments.pop()!;
    let assigned: TypeScript.Node | undefined;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assigned = node.left;
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) assigned = node.operand;
    else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) assigned = node.initializer;
    if (assigned && ts.isIdentifier(assigned) && shorthandNames.has(assigned.text)) return nextAmbiguous();
    ts.forEachChild(node, child => { assignments.push(child); });
  }
  const quote = (value: string) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const edits = [...literals].filter(([name, literal]) => literal.text !== (name === "title" ? title : description))
    .map(([name, literal]) => ({ start: literal.getStart(file), end: literal.getEnd(), text: quote(name === "title" ? title : description) }));
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  if (Buffer.byteLength(updated, "utf8") > MAX_SOURCE_BYTES) throw new Error("El archivo Next.js actualizado superaría 16 MiB.");
  return { updated, current: { title: literals.get("title")!.text, description: literals.get("description")!.text } };
}

type Attribute = { value: string | null; start: number; end: number };
type Tag = { name: string; end: number; closing: boolean; selfClosing: boolean; insert: number; attributes: Map<string, Attribute> };
const HTML_SPACE = /[\t\n\f\r ]/;
function ambiguous(): never {
  throw new Error("Los metadatos HTML son ambiguos o incompatibles. Usa un único head estático explícito con un máximo de un título y una descripción.");
}

// Offset-based scanning preserves every byte outside the two metadata values.
// Fail closed on malformed markup rather than repairing it like a browser parser.
function readTag(html: string, start: number): Tag {
  const match = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(start));
  if (!match) return ambiguous();
  let i = start + match[0].length;
  const attributes = new Map<string, Attribute>();
  const closing = Boolean(match[1]);
  while (i < html.length) {
    const beforeSpace = i;
    while (HTML_SPACE.test(html[i] ?? "")) i++;
    if (html[i] === ">" || html.slice(i, i + 2) === "/>") {
      const selfClosing = html[i] === "/";
      if (closing && selfClosing) return ambiguous();
      return { name: match[2].toLowerCase(), end: i + (selfClosing ? 2 : 1), closing, selfClosing, insert: i, attributes };
    }
    if (closing || i === beforeSpace) return ambiguous();
    const attr = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(html.slice(i));
    if (!attr) return ambiguous();
    const name = attr[0].toLowerCase();
    if (attributes.has(name)) return ambiguous();
    i += attr[0].length;
    const afterName = i;
    while (HTML_SPACE.test(html[i] ?? "")) i++;
    let value: string | null = null;
    let valueStart = i;
    if (html[i] === "=") {
      i++;
      while (HTML_SPACE.test(html[i] ?? "")) i++;
      valueStart = i;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end < 0) return ambiguous();
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const unquoted = /^[^\t\n\f\r "'`=<>]+/.exec(html.slice(i));
        if (!unquoted) return ambiguous();
        value = unquoted[0];
        i += value.length;
      }
    } else {
      // Let the next iteration consume the separating space for boolean attrs.
      i = afterName;
    }
    attributes.set(name, { value, start: valueStart, end: i });
  }
  return ambiguous();
}

/** Edits only title text and meta[name=description] content; never renders HTML. */
export function updateSeoMetadata(html: string, title: string, description: string): string {
  metadata(title, 150, "El título SEO");
  metadata(description, 320, "La descripción SEO");
  validateSource(html);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let phase: "before" | "head" | "after" = "before";
  let headClose = -1;
  let hasTitle = false;
  let hasDescription = false;
  let hasHtml = false;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const end = next < 0 ? html.length : next;
      if (phase !== "after" && html.slice(i, end).trim()) return ambiguous();
      i = end;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const comment = html.slice(i + 4, end);
      if (end < 0 || /^(?:>|->)/.test(comment) || comment.includes("--!>") || comment.includes("<!--")) return ambiguous();
      i = end + 3;
      continue;
    }
    if (/^<!doctype\s+html\s*>/i.test(html.slice(i))) {
      if (phase !== "before" || hasHtml) return ambiguous();
      i += /^<!doctype\s+html\s*>/i.exec(html.slice(i))![0].length;
      continue;
    }
    // A literal less-than in body text is harmless; processing/template syntax isn't.
    if (phase === "after" && !/^<[A-Za-z/!?%]/.test(html.slice(i))) { i++; continue; }
    const tag = readTag(html, i);
    if (tag.name === "head") {
      if (tag.selfClosing) return ambiguous();
      if (!tag.closing) {
        if (phase !== "before") return ambiguous();
        phase = "head";
      } else {
        if (phase !== "head") return ambiguous();
        phase = "after";
        headClose = i;
      }
    } else if (phase === "before") {
      if (tag.name !== "html" || tag.closing || tag.selfClosing || hasHtml) return ambiguous();
      hasHtml = true;
    } else if (phase === "head" && !["title", "meta", "base", "link", "script", "style"].includes(tag.name)) {
      // Body content, templates and noscript can implicitly close/change the head.
      return ambiguous();
    }
    if (["title", "script", "style", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"].includes(tag.name)) {
      if (tag.closing || tag.selfClosing) return ambiguous();
      const closePattern = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, "gi");
      closePattern.lastIndex = tag.end;
      const closeMatch = closePattern.exec(html);
      if (!closeMatch) return ambiguous();
      const close = readTag(html, closeMatch.index);
      const contents = html.slice(tag.end, closeMatch.index);
      // HTML's escaped/double-escaped script states need a full browser parser.
      if (tag.name === "script" && contents.includes("<!--")) return ambiguous();
      if (tag.name === "title") {
        if (phase !== "head" || hasTitle || contents.includes("<") || /\{[{%]/.test(contents)) return ambiguous();
        hasTitle = true;
        edits.push({ start: tag.end, end: closeMatch.index, text: escapeHtml(title) });
      }
      i = close.end;
      continue;
    }
    if (tag.name === "plaintext") return ambiguous();
    if (["meta", "base", "link"].includes(tag.name) && tag.closing) return ambiguous();
    if (tag.name === "meta") {
      const attr = (name: string) => tag.attributes.get(name)?.value;
      if (tag.attributes.has("name") && (attr("name") === null || attr("name")?.includes("&"))) return ambiguous();
      const charset = attr("charset");
      if ((charset !== undefined && !/^utf-?8$/i.test(charset ?? ""))
        || (attr("http-equiv")?.toLowerCase() === "content-type" && !/charset\s*=\s*utf-?8(?:\s|;|$)/i.test(attr("content") ?? ""))) return ambiguous();
      if (attr("name")?.trim().toLowerCase() === "description") {
        if (phase !== "head" || hasDescription || attr("name") !== attr("name")?.trim()) return ambiguous();
        hasDescription = true;
        const content = tag.attributes.get("content");
        if (content?.value === null || (content && /\{[{%]|<[%?]/.test(content.value!))) return ambiguous();
        edits.push(content
          ? { start: content.start, end: content.end, text: `"${escapeHtml(description)}"` }
          : { start: tag.insert, end: tag.insert, text: ` content="${escapeHtml(description)}"` });
      }
    }
    i = tag.end;
  }
  if (headClose < 0) return ambiguous();
  const additions = [!hasTitle && `<title>${escapeHtml(title)}</title>`, !hasDescription && `<meta name="description" content="${escapeHtml(description)}">`].filter(Boolean);
  if (additions.length) {
    const newline = html.includes("\r\n") ? "\r\n" : "\n";
    edits.push({ start: headClose, end: headClose, text: `${newline}${additions.join(newline)}${newline}` });
  }
  let updated = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  if (Buffer.byteLength(updated, "utf8") > MAX_SOURCE_BYTES) throw new Error("El HTML actualizado superaría 16 MiB.");
  return updated;
}

class GithubError extends Error {
  status: number;
  constructor(status: number) {
    const action = status === 401 ? "Revisa SEO_GITHUB_TOKEN."
      : status === 403 ? "Revisa los permisos del repositorio o los límites de solicitudes de GitHub."
        : status === 404 ? "Revisa el repositorio, la rama, la ruta configurada y el acceso del token."
          : status === 409 || status === 422 ? "Revisa los conflictos de rama o contenido y las reglas del repositorio antes de reintentar."
            : status === 429 ? "Espera a que se restablezca el límite de solicitudes de GitHub."
              : status >= 300 && status < 400 ? "Las redirecciones están deshabilitadas; actualiza el repositorio configurado."
                : "Comprueba la disponibilidad de GitHub y reintenta esta ejecución.";
    super(`GitHub: ${status ? `HTTP ${status}` : "la solicitud falló o agotó el tiempo de espera"}. ${action}`);
    this.status = status;
  }
}

type Api = (path: string, method?: "GET" | "POST" | "PUT", body?: unknown, allowMissing?: boolean) => Promise<unknown>;
function githubApi(token: string, repository: string): Api {
  const root = `https://api.github.com/repos/${repository}`;
  return async (path, method = "GET", body, allowMissing = false) => {
    // No upstream/download URLs or model-generated API endpoints are accepted.
    const url = new URL(root + path);
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/repos/${repository}/`)) throw new Error("El destino de la API de GitHub no es válido.");
    let response: Response;
    try {
      response = await fetch(url.href, {
        method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new GithubError(0); }
    if (allowMissing && response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    const expected = method === "POST" ? 201 : 200;
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => {});
      throw new GithubError(response.status);
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_API_BYTES) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new GithubError(0); }
  };
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("GitHub devolvió una identidad de objeto inmutable no válida.");
  return value;
}

function reference(value: unknown, branch: string): string {
  const data = object(value);
  if (data.ref !== `refs/heads/${branch}` || object(data.object).type !== "commit") throw new Error("GitHub devolvió una identidad de rama diferente.");
  return sha(object(data.object).sha);
}

function pullRequest(value: unknown, target: SeoGithubTarget, branch: string): PullRequest | null {
  const data = object(value);
  const head = object(data.head);
  const base = object(data.base);
  const repositoryName = (ref: JsonObject) => String(object(ref.repo).full_name ?? "").toLowerCase();
  if (head.ref !== branch || base.ref !== target.branch || repositoryName(head) !== target.repository || repositoryName(base) !== target.repository) return null;
  if (!Number.isSafeInteger(data.number) || Number(data.number) <= 0) throw new Error("GitHub devolvió una identidad de pull request no válida.");
  const number = Number(data.number);
  // Construct the review URL from verified identity, never trust html_url.
  return { url: `https://github.com/${target.repository}/pull/${number}`, number, branch };
}

async function existingPr(api: Api, target: SeoGithubTarget, branch: string): Promise<PullRequest | null> {
  const query = new URLSearchParams({ state: "all", head: `${target.repository.split("/")[0]}:${branch}`, per_page: "100" });
  const data = await api(`/pulls?${query}`);
  if (!Array.isArray(data) || data.length >= 100) throw new Error("No se pudo identificar con seguridad el pull request SEO existente; revisa esta ejecución en GitHub.");
  const matches = data.map(item => pullRequest(item, target, branch)).filter(item => item !== null);
  if (matches.length > 1) throw new Error("Varios pull requests usan esta rama SEO; revísalos en GitHub.");
  return matches[0] ?? null;
}

async function recoverPr(api: Api, target: SeoGithubTarget, branch: string, reason: string): Promise<PullRequest> {
  // Rechecks are read-only and bounded. An existing branch is never taken over,
  // including a branch left behind after a previous request partially succeeded.
  for (const delay of [0, 250, 750]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { const pr = await existingPr(api, target, branch); if (pr) return pr; }
    catch { break; }
  }
  throw new Error(`${reason} No se confirmó un PR correspondiente a ${branch}. Revisa esa rama en GitHub y reintenta esta ejecución; resuelve manualmente una rama huérfana antes de iniciar otra ejecución. No se sobrescribirá ninguna rama existente.`);
}

// Verify every path component in the immutable tree, then read its exact blob.
// Modes 120000/160000 (symlinks/submodules) are never followed.
async function regularBlob(api: Api, commitSha: string, path: string): Promise<string> {
  const commit = object(await api(`/git/commits/${commitSha}`));
  if (sha(commit.sha) !== commitSha) throw new Error("GitHub devolvió un commit de origen diferente.");
  let treeSha = sha(object(commit.tree).sha);
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const tree = object(await api(`/git/trees/${treeSha}`));
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("GitHub no pudo verificar el árbol de origen completo.");
    const entries = tree.tree.map(object).filter(entry => entry.path === parts[i]);
    if (entries.length !== 1) throw new Error("La ruta configurada no identifica un único archivo existente.");
    const entry = entries[0];
    const last = i === parts.length - 1;
    if (last ? entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode)) : entry.type !== "tree" || entry.mode !== "040000") {
      throw new Error("La ruta configurada debe ser un archivo regular, sin enlaces simbólicos ni submódulos.");
    }
    if (last && entry.size !== undefined && (!Number.isSafeInteger(entry.size) || Number(entry.size) < 1 || Number(entry.size) > MAX_SOURCE_BYTES)) {
      throw new Error("El archivo de origen debe tener un tamaño válido de hasta 16 MiB.");
    }
    treeSha = sha(entry.sha);
  }
  return treeSha;
}

function sourceText(value: unknown, blobSha: string): string {
  const data = object(value);
  if (data.sha !== blobSha || data.encoding !== "base64"
    || data.target !== undefined || data.submodule_git_url !== undefined || !Number.isSafeInteger(data.size)
    || Number(data.size) < 1 || Number(data.size) > MAX_SOURCE_BYTES || typeof data.content !== "string") {
    throw new Error("El origen debe ser el archivo de texto existente configurado, de hasta 16 MiB y con identidad verificada.");
  }
  const encoded = data.content.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== data.size || bytes.toString("base64") !== encoded
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blobSha) {
    throw new Error("Los bytes de origen de GitHub no coinciden con la identidad inmutable del archivo.");
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("El archivo de origen debe ser texto UTF-8 válido."); }
}

function verifyBaseline(current: SeoMetadata, expected: SeoMetadata, desired: SeoMetadata, html: boolean): void {
  // Published HTML audits decode entities and normalize whitespace. Next.js
  // values are actual JS string literals, so they must match exactly.
  const normalize = (value: string) => html ? value.replace(/\s+/g, " ").trim() : value;
  const matches = (other: SeoMetadata) => normalize(current.title) === normalize(other.title)
    && normalize(current.description) === normalize(other.description);
  // analyzeSeo caps its reported fields; never accept a possibly truncated match.
  if ((html && (current.title.length >= 500 || current.description.length >= 1000))
    || (!matches(expected) && !matches(desired))) {
    throw new Error("La evidencia SEO está desactualizada: el título o la descripción del archivo ya no coincide con la auditoría ni con la propuesta. Vuelve a auditar la web y revisa si la compilación sobrescribe sus metadatos antes de crear el PR.");
  }
}

/** Only call with a user-configured, owner-authorized target; AI supplies text only.
 * The caller should always supply the audited baseline in expected. */
export async function createSeoPullRequest(input: { target: SeoGithubTarget; title: string; description: string; runId: string; brandName: string; expected?: SeoMetadata }): Promise<PullRequest> {
  const target = validateTarget(input.target);
  metadata(input.title, 150, "El título SEO");
  metadata(input.description, 320, "La descripción SEO");
  metadata(input.brandName, 120, "El nombre de la marca");
  if (typeof input.runId !== "string" || !UUID.test(input.runId)) throw new Error("El runId SEO debe ser un UUID.");
  const token = process.env.SEO_GITHUB_TOKEN;
  if (!token || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error("Configura SEO_GITHUB_TOKEN con permisos de escritura de Contents y Pull requests en el repositorio.");
  const api = githubApi(token, target.repository);
  const hash = createHash("sha256").update(JSON.stringify([target.url, target.repository, target.branch, target.path])).digest("hex").slice(0, 24);
  const runId = input.runId.toLowerCase();
  const branch = `seo-studio/${runId}-${hash}`;
  const known = await existingPr(api, target, branch);
  if (known) return known;
  if (input.expected !== undefined && (typeof object(input.expected).title !== "string" || typeof object(input.expected).description !== "string")) {
    throw new Error("Los metadatos esperados deben incluir título y descripción de texto de la auditoría.");
  }
  const refPath = (name: string) => `/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`;
  if (await api(refPath(branch), "GET", undefined, true) !== null) {
    return recoverPr(api, target, branch, "La rama SEO determinista ya existe.");
  }
  const sourceSha = reference(await api(refPath(target.branch)), target.branch);
  const blobSha = await regularBlob(api, sourceSha, target.path);
  const contentPath = `/contents/${target.path.split("/").map(encodeURIComponent).join("/")}`;
  // Git Blobs returns base64 beyond the Contents API's 1 MiB inline-content limit.
  const source = sourceText(await api(`/git/blobs/${blobSha}`), blobSha);
  const next = NEXT_ROOT_PATHS.has(target.path) ? await nextMetadataPlan(source, input.title, input.description) : null;
  const updated = next ? next.updated : updateSeoMetadata(source, input.title, input.description);
  if (input.expected !== undefined) {
    const current = next?.current ?? analyzeSeo(source, target.url);
    verifyBaseline(current, input.expected, input, !next);
  }
  if (updated === source) throw new Error("Los metadatos SEO ya coinciden; no se creó ninguna rama ni PR.");
  try {
    const createdSha = reference(await api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: sourceSha }), branch);
    if (createdSha !== sourceSha) throw new Error("La nueva rama SEO no coincide con el commit de origen capturado.");
    // Detect movement after creation. PUT also compares the original file SHA.
    if (reference(await api(refPath(branch)), branch) !== sourceSha) throw new Error("La rama SEO cambió antes de actualizar sus metadatos.");
    const written = object(await api(contentPath, "PUT", {
      message: `Metadatos SEO: ${target.path}`, branch, sha: blobSha,
      content: Buffer.from(updated, "utf8").toString("base64"),
    }));
    const commit = object(written.commit);
    const content = object(written.content);
    const updatedBytes = Buffer.from(updated, "utf8");
    const updatedSha = createHash("sha1").update(`blob ${updatedBytes.length}\0`).update(updatedBytes).digest("hex");
    if (content.path !== target.path || content.sha !== updatedSha || !Array.isArray(commit.parents)
      || commit.parents.length !== 1 || object(commit.parents[0]).sha !== sourceSha
      || reference(await api(refPath(branch)), branch) !== sha(commit.sha)) {
      throw new Error("No se pudo verificar la escritura SEO o la identidad de la rama.");
    }
    // A standard review PR works on repositories without draft support. Never
    // enable auto-merge, force-update refs, or write directly to the base branch.
    const result = await api("/pulls", "POST", {
      title: `Metadatos SEO: ${input.brandName}`, head: branch, base: target.branch,
      body: `Actualiza únicamente los valores de título y descripción SEO de la página configurada.\n\nPágina: ${target.url}\nArchivo: ${target.path}\nEjecución: ${runId}\n\nRevisa los metadatos antes de fusionar.`,
      maintainer_can_modify: false,
    });
    const pr = pullRequest(result, target, branch);
    if (!pr) throw new Error("GitHub devolvió una identidad de pull request diferente.");
    return pr;
  } catch (error) {
    const reason = error instanceof GithubError ? error.message : "No se pudo confirmar la escritura SEO con seguridad.";
    return recoverPr(api, target, branch, reason);
  }
}
