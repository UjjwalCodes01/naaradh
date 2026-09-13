/** Display helpers. Times are shown in the merchant's own zone (tenants.timezone). */

export function formatDateTime(d: Date | null | undefined, zone = 'Asia/Kolkata'): string {
  if (d === null || d === undefined) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function formatDate(d: Date | null | undefined, zone = 'Asia/Kolkata'): string {
  if (d === null || d === undefined) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export function formatMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined) return '—';
  const c = currency ?? 'INR';
  return new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: c,
  }).format(minor / 100);
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m === 0 ? `${String(s)}s` : `${String(m)}m ${String(s).padStart(2, '0')}s`;
}

export function humanise(code: string): string {
  const s = code.replaceAll('_', ' ').replaceAll('.', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
