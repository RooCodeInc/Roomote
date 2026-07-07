import parseDiff from 'parse-diff';

import type { FileDiff, GitDiffLine } from '../types';

/**
 * Parse a unified diff output into structured FileDiff objects.
 *
 * Delegates to the `parse-diff` library and maps its output to our
 * internal types.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff.trim()) {
    return [];
  }

  const parsed = parseDiff(rawDiff);
  const files: FileDiff[] = [];

  for (const file of parsed) {
    const filePath =
      file.to === '/dev/null' ? (file.from ?? '') : (file.to ?? '');

    const isNew = file.new === true;
    const isDeleted = file.deleted === true;

    const diffLines: GitDiffLine[] = [];
    let additions = 0;
    let deletions = 0;

    for (const chunk of file.chunks) {
      diffLines.push({ type: 'header', content: chunk.content });

      for (const change of chunk.changes) {
        // `parse-diff` classifies "\ No newline at end of file" markers
        // with the same type as the preceding line. Reclassify them as context.
        if (change.content === '\\ No newline at end of file') {
          diffLines.push({
            type: 'context',
            content: change.content,
          });

          continue;
        }

        switch (change.type) {
          case 'add':
            additions++;

            diffLines.push({
              type: 'add',
              content: change.content.slice(1),
              newLineNumber: change.ln,
            });

            break;

          case 'del':
            deletions++;

            diffLines.push({
              type: 'remove',
              content: change.content.slice(1),
              oldLineNumber: change.ln,
            });

            break;

          case 'normal':
            diffLines.push({
              type: 'context',
              content: change.content.slice(1),
              oldLineNumber: change.ln1,
              newLineNumber: change.ln2,
            });

            break;
        }
      }
    }

    // Handle binary files: check if the raw section for this file contains a
    // binary marker.
    if (diffLines.length === 0 && filePath) {
      const binaryPattern = new RegExp(
        `Binary files.*${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      );

      if (binaryPattern.test(rawDiff)) {
        const binaryLine = rawDiff
          .split('\n')
          .find((l) => l.startsWith('Binary files') && l.includes(filePath));

        if (binaryLine) {
          diffLines.push({ type: 'header', content: binaryLine });
        }

        files.push({
          path: filePath,
          lines: diffLines,
          additions: 0,
          deletions: 0,
          isNew,
          isDeleted,
        });

        continue;
      }
    }

    if (filePath) {
      files.push({
        path: filePath,
        lines: diffLines,
        additions,
        deletions,
        isNew,
        isDeleted,
      });
    }
  }

  return files;
}
