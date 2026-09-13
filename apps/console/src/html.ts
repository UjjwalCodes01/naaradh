/**
 * Server-rendered HTML for the console: no client JavaScript, no external assets. Every value
 * interpolated with h`` is escaped; raw() is only for markup built here.
 */

export class Raw {
  constructor(readonly value: string) {}
}

export const raw = (value: string): Raw => new Raw(value);

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function esc(value: unknown): string {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function h(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    const s =
      v instanceof Raw
        ? v.value
        : Array.isArray(v)
          ? v.map((x) => (x instanceof Raw ? x.value : esc(x))).join('')
          : esc(v);
    out += s + (strings[i + 1] ?? '');
  });
  return raw(out);
}

const CSS = `body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#0f172a;background:#f8fafc}
header{background:#0f172a;color:#fff;padding:10px 20px;display:flex;gap:18px;align-items:center}
header a{color:#cbd5e1;text-decoration:none}header a:hover{color:#fff}header .who{margin-left:auto;font-size:12px;color:#94a3b8}
main{max-width:1100px;margin:20px auto;padding:0 20px}h1{font-size:20px}h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;color:#64748b;background:#f1f5f9}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin:12px 0}
.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px;background:#e2e8f0}
.warn{background:#fef3c7}.bad{background:#fee2e2}.good{background:#dcfce7}
form.inline{display:inline}input,select,textarea{font:inherit;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px}
button{font:inherit;padding:4px 10px;border-radius:4px;border:0;background:#0f172a;color:#fff;cursor:pointer}button.danger{background:#b91c1c}
.flash{padding:10px;border-radius:6px;margin:12px 0}.flash.ok{background:#dcfce7}.flash.err{background:#fee2e2}
.muted{color:#64748b;font-size:12px}code{font-size:12px}`;

export function page(
  title: string,
  staff: string,
  body: Raw,
  flash?: { ok: boolean; message: string },
): string {
  const nav = [
    ['/', 'Overview'],
    ['/tenants', 'Tenants'],
    ['/complaints', 'Complaints'],
    ['/disputes', 'Disputes'],
    ['/privacy', 'Erasure & DNC'],
    ['/kill-switches', 'Kill switches'],
  ];
  return h`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>${title} · Naaradh console</title><style>${raw(CSS)}</style></head><body>
<header><strong>Naaradh console</strong>${nav.map(([href, label]) => h`<a href="${href}">${label}</a>`)}<span class="who">${staff}</span></header>
<main>${flash === undefined ? '' : h`<div class="flash ${flash.ok ? 'ok' : 'err'}">${flash.message}</div>`}<h1>${title}</h1>${body}</main></body></html>`
    .value;
}

export function badge(text: string, tone: '' | 'warn' | 'bad' | 'good' = ''): Raw {
  return h`<span class="badge ${tone}">${text}</span>`;
}

export function when(d: Date | null | undefined): string {
  if (d === null || d === undefined) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(d);
}
