import { createR2PresignedUrl, env } from "@/lib/runtime";
import { verifyInstagramMediaUrl } from "@/lib/meta";

function currentUser(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!env.BUCKET) return new Response("Media storage unavailable", { status: 503 });

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const ownerId = currentUser(request);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  const isMetaRequest = !!signature && await verifyInstagramMediaUrl(id, expires, signature);
  if (!ownerId && !isMetaRequest) return new Response("Unauthorized", { status: 401 });

  try {
    const object = await env.BUCKET.head(`media/${id}`);
    if (!object || (!isMetaRequest && object.customMetadata?.ownerId !== ownerId)) return new Response("Not found", { status: 404 });
    const mediaUrl = await createR2PresignedUrl("GET", `media/${id}`, {}, 600);
    return Response.redirect(mediaUrl, 302);
  } catch (error) {
    console.error("Unable to read Instagram media", error instanceof Error ? error.message : "unknown error");
    return new Response("Unable to load media", { status: 503 });
  }
}
