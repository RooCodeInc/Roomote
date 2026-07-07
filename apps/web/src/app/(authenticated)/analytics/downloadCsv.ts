'use client';

import type { AnalyticsDetailsColumn, AnalyticsDetailsRow } from '@/types';

type AnalyticsRowsData = {
  columns: AnalyticsDetailsColumn[];
  rows: AnalyticsDetailsRow[];
};

function sanitizeFilePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getTimestampPart(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

const FORMULA_LEADING_PATTERN = /^[\t\r\n ]*[=+\-@]/;

function sanitizeCsvCellValue(value: string) {
  if (FORMULA_LEADING_PATTERN.test(value)) {
    return `'${value}`;
  }

  return value;
}

function escapeCsvCell(value: string) {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function resolveCellValue(
  row: AnalyticsDetailsRow,
  columnKey: string,
  origin: string,
) {
  const href = row.links?.[columnKey];
  if (href) {
    if (href.startsWith('/') && origin) {
      return `${origin}${href}`;
    }

    return href;
  }

  return row.values[columnKey] ?? '';
}

export function downloadAnalyticsRowsCsv({
  data,
  filenamePrefix,
  filenameParts = [],
}: {
  data: AnalyticsRowsData;
  filenamePrefix: string;
  filenameParts?: string[];
}) {
  if (data.columns.length === 0 || data.rows.length === 0) {
    return;
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const headers = data.columns.map((column) => column.label);
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const row of data.rows) {
    const values = data.columns.map((column) =>
      resolveCellValue(row, column.key, origin),
    );
    lines.push(
      values
        .map((value) => escapeCsvCell(sanitizeCsvCellValue(value)))
        .join(','),
    );
  }

  const csv = lines.join('\n');
  const fileParts = [filenamePrefix, ...filenameParts]
    .map(sanitizeFilePart)
    .filter(Boolean);
  const fileName = `${fileParts.join('-') || 'analytics'}-${getTimestampPart()}.csv`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
