import { issueSession, sessionAgeSeconds, sessionCookieName } from "@/lib/session";

export async function POST(request: Request) {
  const password = process.env.ADMIN_PASSWORD;
  const ownerId = process.env.SITE_OWNER_ID;
  if (!password || !process.env.AUTH_SECRET || !ownerId) {
    return Response.json({ error: "Configura ADMIN_PASSWORD, AUTH_SECRET y SITE_OWNER_ID en Vercel." }, { status: 503 });
  }
  let supplied = "";
  try {
    const body = await request.json() as { password?: unknown };
    if (typeof body.password === "string") supplied = body.password;
  } catch {
    return Response.json({ error: "No se pudo leer la contraseña." }, { status: 400 });
  }
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
  if (difference !== 0) return Response.json({ error: "La contraseña no es correcta." }, { status: 401 });

  try {
    const token = await issueSession(ownerId);
    const response = Response.json({ ok: true });
    response.headers.append("set-cookie", `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionAgeSeconds}`);
    return response;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "No se pudo iniciar sesión." }, { status: 503 });
  }
}

