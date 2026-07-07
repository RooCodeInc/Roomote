import { TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';

import type { TaggedStreamChunk } from '../types';

import { publicProcedure } from '../trpc';

import { CommandExecutor, type StreamHandle } from '../lib/command-executor';

function validateFilePath(filePath: string): void {
  if (!filePath || filePath.trim() === '') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Path cannot be empty',
    });
  }

  if (filePath.includes('..')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Path traversal not allowed',
    });
  }

  if (/[;|&$`"'\\<>(){}[\]*?!#~]/.test(filePath)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid characters in path',
    });
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(filePath)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Control characters not allowed in path',
    });
  }
}

/**
 * Multiplexed tail subscription: accepts multiple file paths and streams
 * all of their output over a single SSE connection. Each chunk is tagged
 * with the originating `filePath` so the client can demux into per-file
 * buffers. This avoids exhausting the browser's HTTP/1.1 connection limit
 * (6 per origin) when tailing many log files simultaneously.
 */
export const tailMulti = publicProcedure
  .input(
    z.object({
      filePaths: z.array(z.string().min(1)).min(1).max(20),
    }),
  )
  .subscription(({ ctx, input }) => {
    for (const filePath of input.filePaths) {
      validateFilePath(filePath);
    }

    return observable<TaggedStreamChunk>((emit) => {
      let closed = false;
      const controller = new AbortController();
      const handles: StreamHandle[] = [];

      try {
        for (const filePath of input.filePaths) {
          const handle = CommandExecutor.tailStream(filePath, {
            cwd: ctx.workingDirectory,
            timeout: 0,
            signal: controller.signal,
            onChunk: (chunk) => {
              if (closed) return;
              emit.next({ ...chunk, filePath });
            },
          });

          handles.push(handle);
        }
      } catch (err) {
        controller.abort();

        for (const handle of handles) {
          handle.kill();
        }

        throw err;
      }

      return () => {
        closed = true;
        controller.abort();

        for (const handle of handles) {
          handle.kill();
        }
      };
    });
  });
