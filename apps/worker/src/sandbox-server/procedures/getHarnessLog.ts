import { open } from 'node:fs/promises';

import { z } from 'zod';

import { publicProcedure } from '../trpc';
import { HARNESS_LOG_FILE_NAME } from '../../logging';

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 2_000;
const HARNESS_LOG_PATH = `/tmp/${HARNESS_LOG_FILE_NAME}`;
const READ_CHUNK_BYTES = 64 * 1024;

function tailLines(content: string, lineLimit: number): string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.slice(-lineLimit);
}

async function readTailLines(
  filePath: string,
  lineLimit: number,
): Promise<string[]> {
  const file = await open(filePath, 'r');
  try {
    let end = (await file.stat()).size;
    const chunks: Buffer[] = [];
    let lineBreaks = 0;
    let nextByte = -1;
    let boundariesNeeded = lineLimit;

    // A final terminator creates the empty line that tailLines removes.
    // Unterminated tails need no extra boundary before their first line.
    while (end > 0 && lineBreaks < boundariesNeeded) {
      const start = Math.max(0, end - READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const chunk = buffer.subarray(0, bytesRead);
      if (chunks.length === 0 && (chunk.at(-1) === 10 || chunk.at(-1) === 13)) {
        boundariesNeeded += 1;
      }
      chunks.push(chunk);
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        const byte = chunk[index]!;
        if (byte === 10 || (byte === 13 && nextByte !== 10)) lineBreaks += 1;
        nextByte = byte;
      }
      end = start;
    }

    // Decode after joining so UTF-8 characters split across reads stay intact.
    return tailLines(
      Buffer.concat(chunks.reverse()).toString('utf8'),
      lineLimit,
    );
  } finally {
    await file.close();
  }
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
      const lines = await readTailLines(HARNESS_LOG_PATH, lineLimit);

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
