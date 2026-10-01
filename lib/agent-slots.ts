export function agentSlots(now: number, postingDays: string, time: string) {
  let days: unknown;
  try { days = JSON.parse(postingDays); } catch { return []; }
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!Array.isArray(days) || !match || Number(match[1]) > 23 || Number(match[2]) > 59) return [];
  const local = new Date(now - 5 * 3600_000);
  const slots: Array<{ iso: string; localDate: string }> = [];
  for (let delta = 0; delta < 7; delta++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + delta));
    if (!days.includes(day.getUTCDay())) continue;
    const scheduled = day.getTime() + (Number(match[1]) + 5) * 3600_000 + Number(match[2]) * 60_000;
    if (scheduled < now + 15 * 60_000) continue;
    slots.push({ iso: new Date(scheduled).toISOString(), localDate: day.toISOString().slice(0, 10) });
  }
  return slots;
}
