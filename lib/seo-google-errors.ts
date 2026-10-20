type GoogleErrorPayload = { error?: { status?: string; message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } };

/** Expose known diagnostic codes, never upstream bodies, tokens or arbitrary messages. */
export function seoGoogleError(status: number, host: string, payload: GoogleErrorPayload): string {
  const service = ({
    "www.googleapis.com": "Search Console",
    "mybusinessaccountmanagement.googleapis.com": "Google Business · cuentas",
    "mybusinessbusinessinformation.googleapis.com": "Google Business · información del perfil",
  } as Record<string, string>)[host] ?? "Google";
  const reasons = [...(payload.error?.errors ?? []), ...(payload.error?.details ?? [])].map(item => item.reason ?? "");
  let action = "Verifica los permisos de la cuenta y la configuración de esta API en Google Cloud.";
  let code = "";
  if (reasons.some(r => ["SERVICE_DISABLED", "accessNotConfigured", "API_DISABLED"].includes(r))) {
    code = "API deshabilitada";
    action = "Habilita esta API en el proyecto de Google Cloud que contiene el cliente OAuth de Social Studio y vuelve a cargar las propiedades.";
  } else if (status === 403 && host === "www.googleapis.com" && typeof payload.error?.message === "string" && /(?:sufficient permission for site|permission.*(?:site|property)|not.*verified)/i.test(payload.error.message)) {
    code = "Acceso a la propiedad pendiente";
    action = "Verifica esta propiedad en Search Console o agrega la cuenta conectada como usuario. Tener el dominio en la lista no confirma permiso para consultar sus datos.";
  } else if (reasons.some(r => ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"].includes(r))) {
    code = "Permisos OAuth insuficientes";
    action = "Pulsa Reconectar Google y concede los permisos de Search Console y Google Business solicitados.";
  } else if (status === 429 || reasons.some(r => ["RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "rateLimitExceeded", "dailyLimitExceeded"].includes(r))) {
    code = "Cuota o límite de solicitudes";
    action = host.includes("mybusiness") ? "Revisa la cuota de esta API. Si es 0, solicita acceso básico a Google Business Profile; si ya tienes cuota, espera antes de reintentar." : "Revisa la cuota de Search Console y vuelve a intentar más tarde.";
  } else if (status === 401) {
    action = "Pulsa Reconectar Google para renovar la autorización.";
  } else if (status === 403 && host.includes("mybusiness")) {
    action = "Comprueba que la API esté habilitada, que el proyecto tenga acceso aprobado a Google Business Profile y que esta cuenta administre las fichas.";
  } else if (status === 403 && host === "www.googleapis.com") {
    action = "Comprueba el acceso de la cuenta a esta propiedad y su verificación en Search Console. Revisa también Search Console API y el permiso concedido al conectar Google.";
  }
  return `${service}: HTTP ${status}${code ? ` · ${code}` : ""}. ${action}`;
}
