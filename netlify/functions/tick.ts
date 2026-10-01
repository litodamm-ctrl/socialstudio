import { launchBackground } from "../../lib/netlify-jobs";

export default async () => { await launchBackground("publish-background"); };
export const config = { schedule: "* * * * *" };
