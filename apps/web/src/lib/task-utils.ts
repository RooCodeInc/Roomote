import path from 'path';

import { stripHtml } from 'string-strip-html';
import removeMd from 'remove-markdown';
import { capitalCase } from 'change-case';

export function stripHtmlTags(text: string): string {
  const withBreaks = text.replace(/<br>/g, '\n').replace(/<br \/>/g, '\n');
  const stripped = stripHtml(withBreaks).result;
  return stripped.replace(/[\s\n]+/g, ' ').trim();
}

export function stripMarkdown(md: string): string {
  return removeMd(md);
}

export function humanizeFilename(filePath: string): string {
  // Use path.parse to extract the filename without extension.
  const { name } = path.parse(filePath);
  // Convert to title case using change-case library.
  return capitalCase(name);
}
