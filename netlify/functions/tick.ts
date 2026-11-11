import { launchBackground } from "../../lib/netlify-jobs";

export default async () => {
  const results = await Promise.allSettled([launchBackground("publish-background"), launchBackground("agent-background"), launchBackground("autofill-status")]);
  for (const result of results) if (result.status === "rejected") console.error("No se pudo iniciar una tarea programada", result.reason);
};
export const config = { schedule: "* * * * *" };
