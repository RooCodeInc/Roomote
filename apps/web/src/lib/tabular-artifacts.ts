import type { TabularArtifactFormat } from './artifact-types';

export const TABULAR_PREVIEW_LIMITS = {
  rows: 200,
  columns: 50,
  cellCharacters: 2_000,
} as const;

interface TabularArtifactPreview {
  rows: string[][];
  columnCount: number;
  rowsTruncated: boolean;
  columnsTruncated: boolean;
  cellsTruncated: boolean;
  malformed: boolean;
}

export function parseTabularArtifact(
  content: string,
  format: TabularArtifactFormat,
): TabularArtifactPreview {
  const delimiter = format === 'csv' ? ',' : '\t';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let afterClosingQuote = false;
  let fieldStarted = false;
  let endedWithRowSeparator = false;
  let rowsTruncated = false;
  let columnsTruncated = false;
  let cellsTruncated = false;
  let malformed = false;

  const appendToCell = (value: string) => {
    fieldStarted = true;
    const availableCharacters =
      TABULAR_PREVIEW_LIMITS.cellCharacters - cell.length;
    if (value.length > availableCharacters) cellsTruncated = true;
    if (cell.length < TABULAR_PREVIEW_LIMITS.cellCharacters) {
      cell += value.slice(0, availableCharacters);
    }
  };

  const finishCell = () => {
    if (row.length < TABULAR_PREVIEW_LIMITS.columns) {
      row.push(cell);
    } else {
      columnsTruncated = true;
    }
    cell = '';
    afterClosingQuote = false;
    fieldStarted = false;
  };

  const finishRow = () => {
    finishCell();
    if (rows.length < TABULAR_PREVIEW_LIMITS.rows) {
      rows.push(row);
    } else {
      rowsTruncated = true;
    }
    row = [];
  };

  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]!;
    endedWithRowSeparator = false;

    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          appendToCell('"');
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else if (character === '\r') {
        appendToCell('\n');
        if (content[index + 1] === '\n') index += 1;
      } else {
        appendToCell(character);
      }
      continue;
    }

    if (character === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (character === delimiter) {
      finishCell();
    } else if (character === '\r' || character === '\n') {
      finishRow();
      endedWithRowSeparator = true;
      if (character === '\r' && content[index + 1] === '\n') index += 1;
    } else {
      if (afterClosingQuote) malformed = true;
      appendToCell(character);
    }
  }

  if (content.length > start && !endedWithRowSeparator) finishRow();

  return {
    rows,
    columnCount: rows.reduce(
      (maximum, value) => Math.max(maximum, value.length),
      0,
    ),
    rowsTruncated,
    columnsTruncated,
    cellsTruncated,
    malformed: malformed || inQuotes,
  };
}
