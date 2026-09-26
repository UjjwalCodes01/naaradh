/**
 * Helpers shared by the provider mappings. Nothing here knows a provider.
 */
import { z } from 'zod';

/**
 * A decimal money string (`"1499"`, `"1499.50"`, `"1,499.50"`) to minor units, exactly.
 *
 * Without floats: `Number('1499.50') * 100` is 149950.00000000003 for some values, and money is
 * stored as an integer (CLAUDE.md, Money). Anything unparseable is 0 rather than NaN — a cart
 * whose value we cannot read is still a cart worth recovering, and the value is display-only.
 */
export function decimalToMinor(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim().replace(/,/g, '');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (m === null) return 0;
  const [, sign, whole = '', fraction = ''] = m;
  if (whole === '' && fraction === '') return 0;
  const minorDigits = `${fraction}00`.slice(0, 2);
  // Round on the third decimal, the way a payment provider's own total would.
  const third = fraction.length > 2 ? Number(fraction[2]) : 0;
  const base = Number(`${whole === '' ? '0' : whole}${minorDigits}`) + (third >= 5 ? 1 : 0);
  return sign === '-' ? -base : base;
}

/** `2 × Blue kurta, 1 × Silk scarf` — the line the agent reads back, capped for the prompt. */
export function itemSummaryOf(
  items: readonly { readonly name: string | null | undefined; readonly quantity: number }[],
  limit = 3,
): string {
  const named = items
    .map((i) => ({ name: (i.name ?? '').trim(), quantity: i.quantity }))
    .filter((i) => i.name.length > 0);
  if (named.length === 0) return '';
  const head = named
    .slice(0, limit)
    .map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name))
    .join(', ');
  const rest = named.length - limit;
  return rest > 0 ? `${head} and ${rest} more` : head;
}

export function itemCountOf(items: readonly { readonly quantity: number }[]): number {
  return items.reduce((sum, i) => sum + (Number.isFinite(i.quantity) ? i.quantity : 0), 0);
}

/** First non-empty string, trimmed; null when there is none. */
export function firstText(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const text = (value ?? '').trim();
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * A provider timestamp to a Date. Providers send ISO 8601, Unix seconds or Unix milliseconds;
 * anything unreadable falls back to `fallback` (the time the webhook arrived), because a cart
 * with an unreadable timestamp must still age out of the 24-hour window rather than sit for ever.
 */
export function toDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const text = value.trim();
    const numeric = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (Number.isFinite(numeric)) return toDate(numeric, fallback);
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  return fallback;
}

/** Currency code, upper-cased; INR when the provider omits it (all four are India-first). */
export function currencyOf(value: string | null | undefined, fallback = 'INR'): string {
  const text = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : fallback;
}

/**
 * Line items as every one of these providers sends them: a name under one of several keys and a
 * quantity. Unknown keys are ignored rather than rejected — a provider adding a field must not
 * stop a cart being recovered.
 */
export const LineItem = z
  .object({
    name: z.string().nullish(),
    title: z.string().nullish(),
    sku_name: z.string().nullish(),
    product_name: z.string().nullish(),
    quantity: z.coerce.number().int().nonnegative().catch(1).default(1),
  })
  .passthrough()
  .transform((i) => ({
    name: firstText(i.name, i.title, i.sku_name, i.product_name),
    quantity: i.quantity,
  }));

export type LineItemValue = z.infer<typeof LineItem>;

/** A provider address block, as much of it as any of them agree on. */
export const Address = z
  .object({
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    name: z.string().nullish(),
    phone: z.string().nullish(),
    country_code: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();

/** Two-letter country code from an address block's `country_code` or `country`. */
export function countryOf(
  ...addresses: readonly (z.infer<typeof Address> | null | undefined)[]
): string | null {
  for (const address of addresses) {
    const code = firstText(address?.country_code, address?.country);
    if (code !== null && /^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  return null;
}
