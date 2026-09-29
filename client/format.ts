const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatAgo(iso: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(iso));
  if (elapsedMs < MINUTE_MS) return "vừa xong";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)} phút trước`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)} giờ trước`;
  return `${Math.floor(elapsedMs / DAY_MS)} ngày trước`;
}
