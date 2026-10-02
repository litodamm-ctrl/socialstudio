import { env } from "../../lib/runtime";
import { processDueInstagramPublications } from "../../lib/instagram-publisher";

export default async (request: Request) => {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return;
  if (!env.DB) throw new Error("Configura Cloudflare D1.");
  await processDueInstagramPublications(env);
};
export const config = { background: true };
