import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Social Studio · Calendario de Instagram",
  description: "Organiza y programa contenido de Instagram para tus marcas.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
