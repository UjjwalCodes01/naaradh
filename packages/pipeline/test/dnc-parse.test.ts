import { describe, expect, it } from 'vitest';
import { FAKE_UK, FAKE_US } from '@naaradh/shared/test/fake-phones';
import { parseRegistryLine } from '../src/dnc/registry.js';

/** The registry file formats (P6-CMP-1). Every accepted line comes back as E.164. */
describe('parseRegistryLine', () => {
  it('US: "area,number", run together, or with the leading 1', () => {
    const n = FAKE_US.customer; // +12125550100
    expect(parseRegistryLine(`${n.slice(2, 5)},${n.slice(5)}`, 'US')).toBe(n);
    expect(parseRegistryLine(n.slice(2), 'US')).toBe(n);
    expect(parseRegistryLine(n.slice(1), 'US')).toBe(n);
    expect(parseRegistryLine(`"${n.slice(2, 5)}","${n.slice(5)}"\r`, 'US')).toBe(n);
  });

  it('UK: national format with a leading 0, or with 44', () => {
    const n = FAKE_UK.customer; // +447700900001
    expect(parseRegistryLine(`0${n.slice(3)}`, 'GB')).toBe(n);
    expect(parseRegistryLine(n.slice(1), 'GB')).toBe(n);
  });

  it('rejects headers, short lines and the wrong country’s shape', () => {
    expect(parseRegistryLine('AreaCode,PhoneNumber', 'US')).toBeNull();
    expect(parseRegistryLine('555', 'US')).toBeNull();
    expect(parseRegistryLine(`0${FAKE_UK.customer.slice(3)}`, 'US')).toBeNull();
  });
});
