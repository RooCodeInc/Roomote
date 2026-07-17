import { TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';

import type { TaggedStreamChunk } from '../types';

import { publicProcedure } from '../trpc';

import { CommandExecutor, type StreamHandle } from '../lib/command-executor';
import { resolveSafeTailFilePath } from '../lib/tail-file-path';

function validateFilePath(filePath: string): void {
  try {
    // Validate only; CommandExecutor.tailStream resolves again immediately
    // before spawn so the checked path matches the path passed to `tail`.
    resolveSafeTailFilePath(filePath);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid path',
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
