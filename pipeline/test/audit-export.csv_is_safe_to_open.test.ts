import { describe, expect, it } from 'vitest';
import { auditCsvLine, auditExportRange, csvCell, type AuditExportRow } from '../src/index.js';

/**
 * P7-ENT-1: auditors open the export in a spreadsheet. A cell must never execute as a formula,
 * and a quote in the data must never break the columns.
 */

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("http://x","click")', `"'=HYPERLINK(""http://x"",""click"")"`],
    ['+1+1', `"'+1+1"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1:A9)', `"'@SUM(A1:A9)"`],
    ['\tcmd', `"'\tcmd"`],
  ])('neutralises a formula: %s', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('doubles quotes and keeps commas and newlines inside one quoted cell', () => {
    expect(csvCell('a "b", c\nd')).toBe('"a ""b"", c\nd"');
  });

  it('renders dates as UTC ISO and objects as JSON', () => {
    expect(csvCell(new Date('2026-09-28T10:00:00Z'))).toBe('"2026-09-28T10:00:00.000Z"');
    expect(csvCell({ status: 'active' })).toBe('"{""status"":""active""}"');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('leaves an ordinary value alone', () => {
    expect(csvCell('user.signed_in')).toBe('"user.signed_in"');
  });
});

describe('auditCsvLine', () => {
  it('writes one row in header order, with a hostile actor defused', () => {
    const row: AuditExportRow = {
      id: 'aud_01AAAAAAAAAAAAAAAAAAAAAAAA',
      at: new Date('2026-09-28T10:00:00Z'),
      actorType: 'user',
      actor: '=cmd|"/c calc"!A1@x.example',
      action: 'recording.accessed',
      targetType: 'attempt',
      targetId: 'att_01AAAAAAAAAAAAAAAAAAAAAAAA',
      before: null,
      after: { via: 'dashboard' },
      requestId: 'req-1',
    };
    const cells = auditCsvLine(row);
    expect(cells.startsWith('"2026-09-28T10:00:00.000Z","user","\'=cmd|')).toBe(true);
    expect(cells.endsWith('"{""via"":""dashboard""}"')).toBe(true);
  });
});

describe('auditExportRange', () => {
  const d = (s: string) => new Date(s);
  const check = (from: string, to: string) => () => {
    auditExportRange(d(from), d(to));
  };
  it('accepts a year', () => {
    expect(check('2025-09-28', '2026-09-28')).not.toThrow();
  });
  it('refuses more than 366 days', () => {
    expect(check('2025-01-01', '2026-09-28')).toThrow(/366 days/);
  });
  it('refuses an empty or backwards range', () => {
    expect(check('2026-09-28', '2026-09-28')).toThrow(/after/);
    expect(check('2026-09-28', '2026-01-01')).toThrow(/after/);
  });
  it('refuses an invalid date', () => {
    expect(check('not a date', '2026-09-28')).toThrow(/dates/);
  });
});
