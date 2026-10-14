import { launchBackground } from "../../lib/netlify-jobs";

export default async () => {
  await launchBackground("seo-background");
};
export const config = { schedule: "*/30 * * * *" };
