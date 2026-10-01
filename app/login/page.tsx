"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No se pudo iniciar sesión.");
      const requested = new URL(window.location.href).searchParams.get("return_to") ?? "/";
      window.location.assign(requested.startsWith("/") && !requested.startsWith("//") ? requested : "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesión."); setBusy(false);
    }
  }
  return <main style={{ minHeight: "100svh", display: "grid", placeItems: "center", background: "#f5f7f5", padding: 24 }}>
    <form onSubmit={submit} style={{ width: "min(100%, 420px)", padding: 32, borderRadius: 24, background: "white", boxShadow: "0 20px 60px #16231b14", display: "grid", gap: 18 }}>
      <div><p style={{ margin: "0 0 6px", color: "#668275", fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>SOCIAL STUDIO</p><h1 style={{ margin: 0, fontSize: 28 }}>Iniciar sesión</h1><p style={{ margin: "8px 0 0", color: "#66736c" }}>Ingresa la contraseña de administración para continuar.</p></div>
      <label style={{ display: "grid", gap: 8, fontWeight: 600 }}>Contraseña<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required style={{ height: 46, border: "1px solid #ccd7d0", borderRadius: 10, padding: "0 12px", font: "inherit" }} /></label>
      {error && <p role="alert" style={{ color: "#a92832", margin: 0 }}>{error}</p>}
      <button disabled={busy} style={{ height: 46, border: 0, borderRadius: 10, background: "#17392f", color: "white", font: "inherit", fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>{busy ? "Entrando…" : "Entrar"}</button>
    </form>
  </main>;
}
