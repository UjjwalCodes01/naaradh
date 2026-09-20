import { describe, expect, it } from 'vitest';
import { billedMinutes, inboundPlanFor } from '../src/inbound/billing.js';
import { snippet, toTsQuery } from '../src/inbound/knowledge.js';
import { hashPincode, pincodeMatches } from '../src/inbound/orders.js';
import { scrubArgs, hashConfirmToken, newConfirmToken } from '../src/inbound/agent-actions.js';
import { cleanSummary, ticketPriority } from '../src/inbound/tickets.js';
import { effectiveIdentity } from '../src/inbound/identity.js';

const KEY = 'k'.repeat(32);

describe('knowledge search query (spoken input is data)', () => {
  it('turns speech into OR-ed prefix terms, dropping filler and operators', () => {
    expect(toTsQuery('Can I return my kurta?')).toBe('can:* | return:* | kurta:*');
    expect(toTsQuery("!!! & | ( ') --")).toBeNull();
    expect(toTsQuery('return RETURN return')).toBe('return:*');
  });

  it('keeps Hindi and Hinglish words intact', () => {
    expect(toTsQuery('वापसी policy kya hai')).toBe('वापसी:* | policy:* | kya:* | hai:*');
    expect(toTsQuery('रिफंड कब मिलेगा')).toBe('रिफंड:* | मिलेगा:*');
  });

  it('caps the number of terms', () => {
    const q = toTsQuery(Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(' '));
    expect(q?.split(' | ')).toHaveLength(12);
  });

  it('snippets end on a sentence, never mid-rule', () => {
    const body =
      'Returns are accepted within 7 days. Refunds take 5 to 7 working days. Sale items cannot be returned.';
    expect(snippet(body, 1000)).toBe(body);
    expect(snippet(body, 80)).toBe(
      'Returns are accepted within 7 days. Refunds take 5 to 7 working days.',
    );
    expect(snippet('one two three four five six seven', 12).endsWith('…')).toBe(true);
  });
});

describe('inbound minutes (Q-17)', () => {
  it('rounds up per call, zero for no connection', () => {
    expect(billedMinutes(0)).toBe(0);
    expect(billedMinutes(null)).toBe(0);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60)).toBe(1);
    expect(billedMinutes(61)).toBe(2);
    expect(billedMinutes(Number.NaN)).toBe(0);
  });

  it('plan defaults, service-only overrides, and a pessimistic no-plan default', () => {
    const t = (o: Partial<Parameters<typeof inboundPlanFor>[0]> = {}) => ({
      planCode: null,
      inboundPlanCode: null,
      overrides: {},
      currency: 'INR',
      ...o,
    });
    expect(inboundPlanFor(t({ inboundPlanCode: 'inbound_starter' }))).toEqual({
      includedMinutes: 500,
      overagePaise: 600,
    });
    expect(
      inboundPlanFor(
        t({ inboundPlanCode: 'inbound_scale', overrides: { inbound_unit_minor: 350 } }),
      ),
    ).toEqual({ includedMinutes: 4000, overagePaise: 350 });
    expect(inboundPlanFor(t())).toEqual({ includedMinutes: 0, overagePaise: 600 });
    // An outbound plan_code plus a support-line plan.
    expect(inboundPlanFor(t({ planCode: 'growth', inboundPlanCode: 'inbound_starter' }))).toEqual({
      includedMinutes: 500,
      overagePaise: 600,
    });
    // A support-line-only tenant may carry its inbound plan in plan_code.
    expect(inboundPlanFor(t({ planCode: 'inbound_growth' }))).toEqual({
      includedMinutes: 1500,
      overagePaise: 500,
    });
    // Garbage overrides are ignored, never trusted.
    expect(
      inboundPlanFor(
        t({
          inboundPlanCode: 'inbound_growth',
          overrides: { inbound_included_minutes: -5, inbound_unit_minor: '1' },
        }),
      ),
    ).toEqual({
      includedMinutes: 1500,
      overagePaise: 500,
    });
  });
});

describe('identity factors', () => {
  it('pincode hashes normalise spacing and case and compare in constant time', () => {
    const stored = hashPincode(KEY, '110001');
    expect(pincodeMatches(KEY, '110 001', stored)).toBe(true);
    expect(pincodeMatches(KEY, '110002', stored)).toBe(false);
    expect(pincodeMatches(KEY, '110001', null)).toBe(false);
    expect(hashPincode(KEY, 'sw1a 1aa')).toBe(hashPincode(KEY, 'SW1A1AA'));
  });

  it('an outbound call starts at caller_id (we dialled the number); inbound starts where admission left it', () => {
    const base = { attemptId: 'att_x', callerHash: 'h', verifiedOrderIds: [], verifyFailures: 0 };
    expect(effectiveIdentity({ ...base, direction: 'outbound', identity: 'none' })).toBe(
      'caller_id',
    );
    expect(effectiveIdentity({ ...base, direction: 'inbound', identity: 'none' })).toBe('none');
    expect(effectiveIdentity({ ...base, direction: 'outbound', identity: 'knowledge' })).toBe(
      'knowledge',
    );
  });

  it('confirmation tokens: the model sees the token, storage sees only its hash', () => {
    const { token, hash } = newConfirmToken();
    expect(token).toMatch(/^ct_[A-Za-z0-9_-]{24}$/);
    expect(hash).toBe(hashConfirmToken(token));
    expect(hash).not.toContain(token);
    expect(newConfirmToken().token).not.toBe(token);
  });
});

describe('agent action records are PII-scrubbed', () => {
  it('redacts identity factors and free text, keeps the shape', () => {
    expect(
      scrubArgs({
        order_ref: '1001',
        pincode: '110001',
        confirm_token: 'ct_abc',
        new_address_summary: 'Flat 2',
        reason: 'late',
      }),
    ).toEqual({
      order_ref: '1001',
      pincode: '[redacted]',
      confirm_token: '[redacted]',
      new_address_summary: '[redacted]',
      reason: 'late',
    });
    expect(scrubArgs({ summary: '' })).toEqual({ summary: '' });
    expect(scrubArgs({ phone: '+916000000001' })).toEqual({ phone: '[redacted]' });
  });
});

describe('tickets', () => {
  it('summaries lose control and bidi characters and are capped', () => {
    const rlo = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    expect(cleanSummary(`refund${rlo} please${nul}\n\nnow`)).toBe('refund please now');
    expect(cleanSummary('x'.repeat(5000))).toHaveLength(1000);
  });

  it('money and address first, then callbacks', () => {
    expect(ticketPriority('refund', false)).toBeGreaterThan(ticketPriority('callback', true));
    expect(ticketPriority('callback', true)).toBeGreaterThan(ticketPriority('product', false));
  });
});
