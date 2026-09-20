import { formatMinor } from '@naaradh/pipeline';

/** ₹1,999 rather than ₹1999.00 when the amount is a whole number of rupees. */
export function rupees(minor: number): string {
  return minor % 100 === 0
    ? `₹${(minor / 100).toLocaleString('en-IN')}`
    : formatMinor(minor, 'INR');
}

/** $24 rather than $24.00; cents shown when there are any ($0.12). */
export function dollars(minor: number): string {
  return minor % 100 === 0
    ? `$${(minor / 100).toLocaleString('en-US')}`
    : formatMinor(minor, 'USD');
}
