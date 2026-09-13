/**
 * Money is integer minor units + an ISO currency, everywhere (CLAUDE.md). No floats, no
 * implicit currency, no arithmetic across currencies.
 */
export interface Money {
  readonly minor: number;
  readonly currency: string;
}

const CURRENCY = /^[A-Z]{3}$/;

export function money(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor))
    throw new TypeError(`money(): minor units must be a safe integer, got ${String(minor)}`);
  if (!CURRENCY.test(currency)) throw new TypeError(`money(): bad currency ${currency}`);
  return { minor, currency };
}

export const paise = (n: number): Money => money(n, 'INR');
export const rupees = (n: number): Money => money(Math.round(n * 100), 'INR');

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new TypeError(`cannot add ${a.currency} to ${b.currency}`);
  return money(a.minor + b.minor, a.currency);
}

export function multiplyMoney(m: Money, qty: number): Money {
  if (!Number.isSafeInteger(qty)) throw new TypeError('quantity must be an integer');
  return money(m.minor * qty, m.currency);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency)
    throw new TypeError(`cannot compare ${a.currency} to ${b.currency}`);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

/** Gross margin as a fraction, e.g. 0.62. Both in the same currency. */
export function grossMargin(price: Money, cost: Money): number {
  if (price.currency !== cost.currency) throw new TypeError('margin needs one currency');
  if (price.minor === 0) return 0;
  return (price.minor - cost.minor) / price.minor;
}

const MINOR_DIGITS: Readonly<Record<string, number>> = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 };

/** For dashboards and emails only — never parse this back. */
export function formatMoney(m: Money, locale = 'en-IN'): string {
  const digits = MINOR_DIGITS[m.currency] ?? 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: digits,
  }).format(m.minor / 10 ** digits);
}
