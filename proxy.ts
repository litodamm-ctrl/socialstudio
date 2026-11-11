import { NextRequest, NextResponse } from "next/server";
import { sessionCookieName, verifySession } from "@/lib/session";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth/login" || pathname.startsWith("/.netlify/functions/")) return NextResponse.next();
  if (request.method === "GET" && pathname === "/api/internal/autofill-progress") return NextResponse.next();
  if (pathname.startsWith("/api/media/") && request.method === "GET" && request.nextUrl.searchParams.has("signature")) return NextResponse.next();

  // Only unguessable, consented photo grants and the exact TikTok ownership file are public.
  if (["GET", "HEAD"].includes(request.method) && /^\/api\/tiktok\/media\/[A-Za-z0-9_-]{64}$/.test(pathname)) return NextResponse.next();
  if (request.method === "GET" && pathname === `/${process.env.TIKTOK_VERIFICATION_FILE}` && /^\/tiktok[A-Za-z0-9_-]+\.txt$/.test(pathname)) return NextResponse.next();

  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (pathname === "/api/cron/publish" && cronSecret && authorization === `Bearer ${cronSecret}`) return NextResponse.next();
  const session = await verifySession(request.cookies.get(sessionCookieName)?.value);
  if (!session) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Inicia sesión para continuar." }, { status: 401 });
    const login = new URL("/login", request.url);
    login.searchParams.set("return_to", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  const headers = new Headers(request.headers);
  headers.set("oai-authenticated-user-id", session.ownerId);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

