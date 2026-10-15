import { randomUUID } from 'node:crypto';
import type { SessionInfo } from '@discordjs/ws';
import { db, discordGatewaySessions, eq } from '@roomote/db/server';
import {
  clearDiscordGatewayResumeState,
  findDiscordGatewayResumeState,
  recordDiscordGatewayHeartbeatAck,
  saveDiscordGatewayResumeState,
  updateDiscordGatewaySequence,
} from '@roomote/sdk/server/discord-persistence';

import { DiscordGatewayResumeStore } from './gateway-resume-store';

it.each(['success', 'failure'] as const)(
  'isolates a replacement session from an old checkpoint %s',
  async (outcome) => {
    const fingerprint = `resume-race-${randomUUID()}`;
    const key = { tokenFingerprint: fingerprint, shardId: 0 };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let writes = 0;
    const store = new DiscordGatewayResumeStore(
      fingerprint,
      {
        find: findDiscordGatewayResumeState,
        save: saveDiscordGatewayResumeState,
        clear: clearDiscordGatewayResumeState,
        recordHeartbeat: recordDiscordGatewayHeartbeatAck,
        updateSequence: async (input) => {
          writes += 1;
          if (writes === 1) {
            started();
            await blocked;
            if (outcome === 'failure')
              throw new Error('Delayed old write failed');
          }
          await updateDiscordGatewaySequence(input);
        },
      },
      60_000,
    );
    const oldSession: SessionInfo = {
      sessionId: 'old-session',
      resumeURL: 'wss://gateway.example.test',
      sequence: 10,
      shardId: 0,
      shardCount: 1,
    };
    let flush: Promise<void> | undefined;
    try {
      await store.update(0, oldSession);
      await store.update(0, { ...oldSession, sequence: 11 });
      expect(store.acknowledgeDispatch(0, 11)).toBe(true);
      flush = store.flush();
      await writing;

      const replacement = {
        ...oldSession,
        sessionId: 'new-session',
        sequence: 0,
      };
      await store.update(0, replacement);
      await expect(findDiscordGatewayResumeState(key)).resolves.toMatchObject({
        sessionId: 'new-session',
        sequence: 0,
      });
      release();
      if (outcome === 'failure') {
        await expect(flush).rejects.toThrow('Delayed old write failed');
      } else {
        await flush;
      }
      // A stale failure must not be restored as work belonging to the new session.
      await store.flush();
      await store.update(0, { ...replacement, sequence: 12 });

      expect
        .soft(await findDiscordGatewayResumeState(key))
        .toMatchObject({ sessionId: 'new-session', sequence: 0 });
      expect
        .soft(await store.retrieve(0))
        .toMatchObject({ sessionId: 'new-session', sequence: 0 });
      const restarted = new DiscordGatewayResumeStore(fingerprint);
      expect
        .soft(await restarted.retrieve(0))
        .toMatchObject({ sessionId: 'new-session', sequence: 0 });
      expect(store.acknowledgeDispatch(0, 1)).toBe(true);
      await store.flush();
      expect(await findDiscordGatewayResumeState(key)).toMatchObject({
        sessionId: 'new-session',
        sequence: 1,
      });
      expect(await store.retrieve(0)).toMatchObject({
        sessionId: 'new-session',
        sequence: 1,
      });
    } finally {
      release();
      await flush?.catch(() => undefined);
      await store.update(0, null);
      await db
        .delete(discordGatewaySessions)
        .where(eq(discordGatewaySessions.id, `${fingerprint}:0`));
    }
  },
);
