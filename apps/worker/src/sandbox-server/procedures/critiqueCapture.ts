import { readFile, unlink } from 'node:fs/promises';

import { z } from 'zod';
import { execa } from 'execa';

import {
  captureCritiquePage,
  type CaptureRecord,
} from '../../mcp/roomote-mcp-server/critique';
import { critiqueControlProcedure } from '../trpc';

type StoredCapture = {
  record: CaptureRecord;
  screenshotBase64: string;
  domJson: string;
};

const captures = new Map<string, StoredCapture>();

export const critiqueCapture = critiqueControlProcedure
  .input(
    z.discriminatedUnion('action', [
      z.object({ action: z.literal('capture') }),
      z.object({
        action: z.literal('read'),
        captureIds: z.array(z.string()).min(1).max(4),
      }),
    ]),
  )
  .mutation(async ({ ctx, input }) => {
    if (input.action === 'read') {
      return {
        action: 'read' as const,
        captures: input.captureIds.map((id) => {
          const capture = captures.get(id);
          if (!capture) throw new Error(`Critique capture not found: ${id}`);
          return capture;
        }),
      };
    }

    if (!ctx.taskRunTaskId) throw new Error('Task ID is unavailable');
    const record = await captureCritiquePage(
      undefined,
      async (args, options) => {
        const result = await execa('agent-browser', args, {
          input: options?.input,
          signal: options?.signal,
          env: { AGENT_BROWSER_SESSION: ctx.taskRunTaskId },
        });
        return result.stdout;
      },
    );
    const [screenshot, domJson] = await Promise.all([
      readFile(record.screenshotPath),
      readFile(record.domPath, 'utf8'),
    ]);
    await Promise.all([
      unlink(record.screenshotPath).catch(() => undefined),
      unlink(record.domPath).catch(() => undefined),
    ]);
    captures.set(record.id, {
      record,
      screenshotBase64: screenshot.toString('base64'),
      domJson,
    });
    while (captures.size > 8) captures.delete(captures.keys().next().value!);
    return { action: 'capture' as const, capture: record };
  });
