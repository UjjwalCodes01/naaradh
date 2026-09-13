import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId, parseId } from '../src/index.js';

describe('prefixed ids', () => {
  it('mints an id with the documented prefix for every kind', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
      expect(isId(kind, id)).toBe(true);
    }
  });

  it('sorts lexicographically by creation order, even within one millisecond', () => {
    // A worker writing several attempts or audit rows in the same tick is ordinary, so
    // same-millisecond ids must still sort. This is why ids.ts uses ulid's
    // monotonicFactory: plain ulid() re-randomises entropy and would sort arbitrarily here.
    const minted = Array.from({ length: 50 }, () => newId('intent'));
    expect([...minted].sort()).toEqual(minted);
  });

  it('rejects an id of the wrong kind', () => {
    const attempt = newId('attempt');
    expect(isId('intent', attempt)).toBe(false);
    expect(() => parseId('intent', attempt)).toThrow(TypeError);
  });

  it('rejects a prefix with a malformed ulid', () => {
    expect(isId('intent', 'int_not-a-ulid')).toBe(false);
    // I, L, O and U are excluded from Crockford base32.
    expect(isId('intent', 'int_IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false);
  });
});
