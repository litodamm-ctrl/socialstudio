import { env } from "@/lib/runtime";

type AccountRow = { brand: string; username: string; token_expires_at: number };

export async function GET(request: Request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para ver tus cuentas." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Las cuentas no están disponibles todavía." }, { status: 503 });

  try {
    const result = await env.DB.prepare(
      "SELECT brand, username, token_expires_at FROM instagram_accounts WHERE owner_id = ? ORDER BY brand",
    ).bind(ownerId).all<AccountRow>();
    return Response.json({ accounts: (result.results ?? []).map((account) => ({
      brand: account.brand,
      username: account.username,
      tokenExpiresAt: new Date(account.token_expires_at).toISOString(),
    })) });
  } catch (error) {
    console.error("Unable to load connected Instagram accounts", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudieron cargar las cuentas conectadas." }, { status: 503 });
  }
}
