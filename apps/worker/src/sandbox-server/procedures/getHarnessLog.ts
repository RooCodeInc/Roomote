import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { publicProcedure } from '../trpc';
import { HARNESS_LOG_FILE_NAME } from '../../logging';

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 2_000;
const HARNESS_LOG_PATH = `/tmp/${HARNESS_LOG_FILE_NAME}`;

function tailLines(content: string, lineLimit: number): string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.slice(-lineLimit);
}

export const getHarnessLog = publicProcedure
  .input(
    z
      .object({
        lineLimit: z.number().int().min(1).max(MAX_LINE_LIMIT).optional(),
      })
      .optional(),
  )
  .query(async ({ input }) => {
    const lineLimit = input?.lineLimit ?? DEFAULT_LINE_LIMIT;

    try {
      const content = await readFile(HARNESS_LOG_PATH, 'utf8');
      const lines = tailLines(content, lineLimit);

      return {
        path: HARNESS_LOG_PATH,
        exists: true,
        requestedLines: lineLimit,
        returnedLines: lines.length,
        lines,
      };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {
          path: HARNESS_LOG_PATH,
          exists: false,
          requestedLines: lineLimit,
          returnedLines: 0,
          lines: [] as string[],
        };
      }

      throw error;
    }
  });
