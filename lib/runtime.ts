type D1Meta = { changes?: number; last_row_id?: number; duration?: number };
type D1Result<T> = { results?: T[]; success: boolean; meta?: D1Meta; error?: string };
type D1Response<T> = { result?: D1Result<T>[]; success?: boolean; errors?: Array<{ message?: string }> };

class HttpD1Statement {
  private params: unknown[] = [];
  private readonly db: HttpD1Database;
  private readonly sql: string;
  constructor(db: HttpD1Database, sql: string) { this.db = db; this.sql = sql; }
  bind(...params: unknown[]) { this.params = params; return this; }
  toQuery() { return { sql: this.sql, params: this.params }; }
  async all<T = Record<string, unknown>>() { return this.db.query<T>(this.sql, this.params); }
  async first<T = Record<string, unknown>>() { return (await this.all<T>()).results[0] ?? null; }
  async run<T = Record<string, unknown>>() { return this.db.query<T>(this.sql, this.params); }
}

class HttpD1Database {
  private readonly endpoint: string;
  private readonly token: string;
  constructor(accountId: string, databaseId: string, token: string) {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
    this.token = token;
  }
  prepare(sql: string) { return new HttpD1Statement(this, sql); }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const payload = await this.send<T>({ sql, params });
    const result = payload.result?.[0];
    return { results: result?.results ?? [], success: result?.success ?? true, meta: result?.meta ?? { changes: 0 } };
  }
  async batch(statements: HttpD1Statement[]) {
    const payload = await this.send({ batch: statements.map((statement) => statement.toQuery()) });
    return payload.result ?? [];
  }
  private async send<T>(body: { sql: string; params: unknown[] } | { batch: Array<{ sql: string; params: unknown[] }> }): Promise<D1Response<T>> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json() as D1Response<T>;
    if (!response.ok || payload.success === false || payload.result?.some((item) => !item.success)) {
      const reason = payload.errors?.map((item) => item.message).filter(Boolean).join("; ") || payload.result?.find((item) => !item.success)?.error || `HTTP ${response.status}`;
      throw new Error(`Cloudflare D1 query failed: ${reason}`);
    }
    return payload;
  }
}

function utf8(value: string) { return new TextEncoder().encode(value); }
function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: Uint8Array | string) {
  return hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? utf8(value) : new Uint8Array(value)));
}
async function hmac(key: Uint8Array | string, value: string) {
  const raw = typeof key === "string" ? utf8(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8(value)));
}
function encodePathPart(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function toBytes(value: BodyInit | ReadableStream<Uint8Array>) {
  if (value instanceof ReadableStream) return new Response(value).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  if (value instanceof Blob) return value.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Promise.resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return new Response(value).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

type R2HttpMetadata = { contentType?: string };
type R2PutOptions = { httpMetadata?: R2HttpMetadata; customMetadata?: Record<string, string> };
type R2ObjectLike = {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpEtag: string;
  customMetadata: Record<string, string>;
  httpMetadata: R2HttpMetadata;
  arrayBuffer(): Promise<ArrayBuffer>;
  writeHttpMetadata(headers: Headers): void;
};

class HttpR2Bucket {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  constructor(accountId: string, bucket: string, accessKey: string, secretKey: string) {
    this.endpoint = `${accountId}.r2.cloudflarestorage.com`;
    this.bucket = bucket;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }
  private objectUrl(key: string) {
    const path = `/${encodePathPart(this.bucket)}/${key.split("/").map(encodePathPart).join("/")}`;
    return new URL(`https://${this.endpoint}${path}`);
  }
  async presign(method: "GET" | "PUT", key: string, metadata: Record<string, string>, expiresSeconds: number) {
    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const scope = `${date}/auto/s3/aws4_request`;
    const canonicalHeaders: Record<string, string> = { host: url.host };
    for (const [name, value] of Object.entries(metadata)) canonicalHeaders[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
    const signedHeaders = Object.keys(canonicalHeaders).sort().join(";");
    const signedQuery: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
    };
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const query = Object.entries(signedQuery).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
    const headers = Object.keys(canonicalHeaders).sort().map((name) => `${name}:${canonicalHeaders[name]}\n`).join("");
    const canonicalRequest = [method, url.pathname, query, headers, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n");
    const dateKey = await hmac(`AWS4${this.secretKey}`, date);
    const regionKey = await hmac(dateKey, "auto");
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    url.search = `${query}&X-Amz-Signature=${signature}`;
    return url.toString();
  }
  private async request(method: string, key: string, body?: Uint8Array, metadata: Record<string, string> = {}) {
    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = await sha256(body ?? new Uint8Array());
    const canonical: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    for (const [name, value] of Object.entries(metadata)) canonical[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
    const signedHeaders = Object.keys(canonical).sort().join(";");
    const canonicalHeaders = Object.keys(canonical).sort().map((name) => `${name}:${canonical[name]}\n`).join("");
    const request = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(request)].join("\n");
    const dateKey = await hmac(`AWS4${this.secretKey}`, date);
    const regionKey = await hmac(dateKey, "auto");
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    const headers = new Headers({
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    });
    for (const [name, value] of Object.entries(metadata)) headers.set(name, value);
    return fetch(url, { method, headers, body: body ? new Blob([new Uint8Array(body)]) : undefined, cache: "no-store" });
  }
  private object(response: Response): R2ObjectLike {
    const customMetadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith("x-amz-meta-")) customMetadata[name.slice("x-amz-meta-".length)] = value;
    });
    for (const name of Object.keys(customMetadata)) {
      const normalized = ({ ownerid: "ownerId", brandid: "brandId", generatedby: "generatedBy" } as Record<string, string>)[name.toLowerCase()];
      if (normalized) { customMetadata[normalized] = customMetadata[name]; delete customMetadata[name]; }
    }
    const httpMetadata = { contentType: response.headers.get("content-type") ?? undefined };
    const object = {
      body: response.body,
      size: Number(response.headers.get("content-length") ?? 0),
      httpEtag: response.headers.get("etag") ?? "",
      customMetadata,
      httpMetadata,
      arrayBuffer: () => response.arrayBuffer(),
      writeHttpMetadata: (headers: Headers) => { if (httpMetadata.contentType) headers.set("content-type", httpMetadata.contentType); },
    };
    return object;
  }
  async put(key: string, value: BodyInit | ReadableStream<Uint8Array>, options: R2PutOptions = {}) {
    const bytes = await toBytes(value);
    const metadata: Record<string, string> = {};
    if (options.httpMetadata?.contentType) metadata["content-type"] = options.httpMetadata.contentType;
    for (const [name, content] of Object.entries(options.customMetadata ?? {})) metadata[`x-amz-meta-${name.toLowerCase()}`] = content;
    const response = await this.request("PUT", key, bytes, metadata);
    if (!response.ok) throw new Error(`Cloudflare R2 upload failed: HTTP ${response.status} ${await response.text()}`);
    return this.object(response);
  }
  async get(key: string) {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare R2 read failed: HTTP ${response.status}`);
    return this.object(response);
  }
  async head(key: string) {
    const response = await this.request("HEAD", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare R2 metadata read failed: HTTP ${response.status}`);
    return this.object(response);
  }
  async delete(key: string) {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) throw new Error(`Cloudflare R2 delete failed: HTTP ${response.status}`);
  }
}

const database = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_D1_DATABASE_ID && process.env.CLOUDFLARE_API_TOKEN
  ? new HttpD1Database(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_D1_DATABASE_ID, process.env.CLOUDFLARE_API_TOKEN)
  : undefined;
const bucket = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.R2_BUCKET_NAME && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new HttpR2Bucket(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.R2_BUCKET_NAME, process.env.R2_ACCESS_KEY_ID, process.env.R2_SECRET_ACCESS_KEY)
  : undefined;

export const env = {
  DB: database as unknown as D1Database | undefined,
  BUCKET: bucket as unknown as R2Bucket | undefined,
  INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET,
  INSTAGRAM_REDIRECT_URI: process.env.INSTAGRAM_REDIRECT_URI,
  INSTAGRAM_TOKEN_ENCRYPTION_KEY: process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY,
  META_GRAPH_VERSION: process.env.META_GRAPH_VERSION,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  SITE_ORIGIN: process.env.SITE_ORIGIN,
} as Cloudflare.Env & { SITE_ORIGIN?: string };

export async function createR2PresignedUrl(method: "GET" | "PUT", key: string, headers: Record<string, string> = {}, expiresSeconds = 600) {
  if (!(bucket instanceof HttpR2Bucket)) throw new Error("Cloudflare R2 credentials are not configured.");
  return bucket.presign(method, key, headers, expiresSeconds);
}
