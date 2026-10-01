declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    INSTAGRAM_APP_ID?: string;
    INSTAGRAM_APP_SECRET?: string;
    INSTAGRAM_REDIRECT_URI?: string;
    INSTAGRAM_TOKEN_ENCRYPTION_KEY?: string;
    META_GRAPH_VERSION?: string;
    OPENAI_API_KEY?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    SITE_ORIGIN?: string;
  }
}
