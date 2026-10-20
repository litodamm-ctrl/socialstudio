import { processDueTikTokPublications } from "../../lib/tiktok-publisher";
import { env } from "../../lib/runtime";
import { processDueInstagramPublications } from "../../lib/instagram-publisher";

const publishBackground = async (request: Request) => {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return;
  if (!env.DB) throw new Error("Configura Cloudflare D1.");
  await Promise.allSettled([processDueInstagramPublications(env), processDueTikTokPublications(env.DB)]).then(results => { for (const result of results) if (result.status === "rejected") console.error("Scheduled publisher failed", result.reason instanceof Error ? result.reason.message : "Unknown error"); });
};
export default publishBackground;
export const config = { background: true };

