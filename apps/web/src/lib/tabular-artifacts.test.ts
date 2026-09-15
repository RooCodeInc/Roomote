import { getTabularArtifactFormat } from './artifact-types';
import {
  parseTabularArtifact,
  TABULAR_PREVIEW_LIMITS,
} from './tabular-artifacts';

describe('tabular artifacts', () => {
  it.each([
    ['TEXT/CSV; charset=UTF-8', 'reports/data.bin', 'csv'],
    ['text/tab-separated-values; charset=utf-8', 'reports/data.bin', 'tsv'],
    ['application/octet-stream', 'reports/data.CSV', 'csv'],
    ['text/plain', 'reports/data.TSV', 'tsv'],
    ['application/octet-stream', 'reports/data.tab', 'tsv'],
  ])('detects %s at %s as %s', (contentType, path, expected) => {
    expect(getTabularArtifactFormat(contentType, path)).toBe(expected);
  });

  it('does not classify ordinary text as tabular', () => {
    expect(
      getTabularArtifactFormat('text/plain', 'notes/readme.txt'),
    ).toBeNull();
  });

  it('parses quotes, escaped quotes, embedded newlines, BOM, CRLF, and trailing cells', () => {
    const preview = parseTabularArtifact(
      '\ufeffname,notes,empty\r\n"Ada","line 1\r\nline 2","said ""hi""",\r\n',
      'csv',
    );

    expect(preview.rows).toEqual([
      ['name', 'notes', 'empty'],
      ['Ada', 'line 1\nline 2', 'said "hi"', ''],
    ]);
    expect(preview.columnCount).toBe(4);
    expect(preview.malformed).toBe(false);
  });

  it('parses tabs without treating the first row as headers', () => {
    expect(parseTabularArtifact('first\tsecond\n1\t2', 'tsv').rows).toEqual([
      ['first', 'second'],
      ['1', '2'],
    ]);
  });

  it('returns an empty preview for empty input and flags unclosed quotes', () => {
    expect(parseTabularArtifact('', 'csv').rows).toEqual([]);
    expect(parseTabularArtifact('one,"two', 'csv')).toMatchObject({
      rows: [['one', 'two']],
      malformed: true,
    });
  });

  it('bounds rows, columns, and cell content', () => {
    const oversizedFirstRow = [
      'x'.repeat(TABULAR_PREVIEW_LIMITS.cellCharacters + 1),
      ...Array.from({ length: TABULAR_PREVIEW_LIMITS.columns }, () => 'x'),
    ].join(',');
    const content = [
      oversizedFirstRow,
      ...Array.from({ length: TABULAR_PREVIEW_LIMITS.rows }, () => 'x'),
    ].join('\n');
    const preview = parseTabularArtifact(content, 'csv');

    expect(preview.rows).toHaveLength(TABULAR_PREVIEW_LIMITS.rows);
    expect(preview.columnCount).toBe(TABULAR_PREVIEW_LIMITS.columns);
    expect(preview.rows[0]?.[0]).toHaveLength(
      TABULAR_PREVIEW_LIMITS.cellCharacters,
    );
    expect(preview).toMatchObject({
      rowsTruncated: true,
      columnsTruncated: true,
      cellsTruncated: true,
    });
  });
});
