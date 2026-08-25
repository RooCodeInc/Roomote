import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES,
  FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES,
  FastAgentSpillStore,
} from '../fast-agent-spill-store';

function createStore(
  options: ConstructorParameters<typeof FastAgentSpillStore>[0] = {},
): FastAgentSpillStore {
  return new FastAgentSpillStore({
    rootDirectory: mkdtempSync(join(tmpdir(), 'fast-spill-test-')),
    sweepIntervalMs: 0,
    ...options,
  });
}

describe('FastAgentSpillStore', () => {
  it('shares a child result handle with the parent conversation session', async () => {
    const store = createStore();
    try {
      store.bindSession('child-session', 'conversation-a');
      store.bindSession('parent-session', 'conversation-a');
      const spill = await store.write('child-session', 'child output');
      expect(spill.stored).toBe(true);
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      await expect(
        store.read('parent-session', spill.handle),
      ).resolves.toMatchObject({
        content: 'child output',
        handle: spill.handle,
        offset: 0,
        nextOffset: null,
      });
    } finally {
      await store.dispose();
    }
  });

  it('rejects child and parent sessions from another conversation', async () => {
    const store = createStore();
    try {
      store.bindSession('owner-child', 'conversation-a');
      store.bindSession('other-parent', 'conversation-b');
      store.bindSession('other-child', 'conversation-b');
      const spill = await store.write('owner-child', 'private output');
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      await expect(store.read('other-parent', spill.handle)).rejects.toThrow(
        'unavailable for this conversation',
      );
      await expect(
        store.grep('other-child', spill.handle, 'private'),
      ).rejects.toThrow('unavailable for this conversation');
    } finally {
      await store.dispose();
    }
  });

  it('expires handles and removes their files', async () => {
    let now = 100;
    const store = createStore({ now: () => now, ttlMs: 10 });
    try {
      store.bindSession('session', 'conversation');
      const spill = await store.write('session', 'temporary output');
      if (!spill.stored) throw new Error('Expected spill to be stored.');
      now = 110;

      await expect(store.read('session', spill.handle)).rejects.toThrow(
        'unavailable for this conversation',
      );
    } finally {
      await store.dispose();
    }
  });

  it('removes every handle when a conversation ends', async () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const first = await store.write('session', 'first');
      const second = await store.write('session', 'second');
      if (!first.stored || !second.stored) {
        throw new Error('Expected spills to be stored.');
      }

      await store.cleanupConversation('conversation');

      await expect(store.read('session', first.handle)).rejects.toThrow(
        'unavailable for this conversation',
      );
      await expect(store.read('session', second.handle)).rejects.toThrow(
        'unavailable for this conversation',
      );
    } finally {
      await store.dispose();
    }
  });

  it('enforces per-file and per-conversation byte and file quotas', async () => {
    const fileStore = createStore({ fileQuotaBytes: 4 });
    const byteStore = createStore({
      conversationQuotaBytes: 8,
      fileQuotaBytes: 8,
    });
    const countStore = createStore({ maxFilesPerConversation: 1 });
    try {
      fileStore.bindSession('file-session', 'file-conversation');
      await expect(
        fileStore.write('file-session', '12345'),
      ).resolves.toMatchObject({
        stored: false,
        reason: 'file_quota',
      });

      byteStore.bindSession('byte-session', 'byte-conversation');
      await expect(
        byteStore.write('byte-session', '12345'),
      ).resolves.toMatchObject({
        stored: true,
      });
      await expect(
        byteStore.write('byte-session', '6789'),
      ).resolves.toMatchObject({
        stored: false,
        reason: 'conversation_quota',
      });

      countStore.bindSession('count-session', 'count-conversation');
      await expect(
        countStore.write('count-session', 'first'),
      ).resolves.toMatchObject({
        stored: true,
      });
      await expect(
        countStore.write('count-session', 'second'),
      ).resolves.toMatchObject({
        stored: false,
        reason: 'file_count_quota',
      });
    } finally {
      await fileStore.dispose();
      await byteStore.dispose();
      await countStore.dispose();
    }
  });

  it('enforces process-wide byte and file quotas and releases them on cleanup', async () => {
    const byteStore = createStore({
      conversationQuotaBytes: 8,
      fileQuotaBytes: 8,
      globalQuotaBytes: 8,
    });
    const countStore = createStore({ globalFileQuota: 1 });
    try {
      byteStore.bindSession('byte-a', 'conversation-a');
      byteStore.bindSession('byte-b', 'conversation-b');
      await expect(byteStore.write('byte-a', '12345')).resolves.toMatchObject({
        stored: true,
      });
      await expect(byteStore.write('byte-b', '6789')).resolves.toMatchObject({
        stored: false,
        reason: 'global_quota',
      });
      await byteStore.cleanupConversation('conversation-a');
      await expect(byteStore.write('byte-b', '6789')).resolves.toMatchObject({
        stored: true,
      });

      countStore.bindSession('count-a', 'conversation-a');
      countStore.bindSession('count-b', 'conversation-b');
      await expect(countStore.write('count-a', 'first')).resolves.toMatchObject(
        {
          stored: true,
        },
      );
      await expect(
        countStore.write('count-b', 'second'),
      ).resolves.toMatchObject({
        stored: false,
        reason: 'global_file_quota',
      });
      await countStore.cleanupConversation('conversation-a');
      await expect(
        countStore.write('count-b', 'second'),
      ).resolves.toMatchObject({
        stored: true,
      });
    } finally {
      await byteStore.dispose();
      await countStore.dispose();
    }
  });

  it('returns valid UTF-8 windows at multibyte boundaries', async () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const spill = await store.write('session', 'A😀B');
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      await expect(
        store.read('session', spill.handle, 1, 2),
      ).resolves.toMatchObject({
        content: '😀',
        offset: 1,
        nextOffset: 5,
      });
      await expect(
        store.read('session', spill.handle, 2, 5),
      ).resolves.toMatchObject({
        content: 'B',
        offset: 5,
        nextOffset: null,
      });
    } finally {
      await store.dispose();
    }
  });

  it('streams literal search in bounded pages with byte offsets', async () => {
    const store = createStore({ fileQuotaBytes: 2 * 1024 * 1024 });
    try {
      store.bindSession('session', 'conversation');
      const content = `${'x'.repeat(FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES + 10)}needle`;
      const spill = await store.write('session', content);
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      const first = await store.grep('session', spill.handle, 'needle');
      expect(first).toMatchObject({
        matches: [],
        nextOffset: FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES,
        offset: 0,
        scannedBytes: FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES,
        truncated: true,
      });
      await expect(
        store.grep('session', spill.handle, 'needle', 20, first.nextOffset!),
      ).resolves.toMatchObject({
        matches: [
          {
            offset: FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES + 10,
            preview: expect.stringContaining('needle'),
          },
        ],
        nextOffset: null,
        truncated: false,
      });
    } finally {
      await store.dispose();
    }
  });

  it('keeps heavily escaped search results within the per-call byte budget', async () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const query = '\0'.repeat(512);
      const spill = await store.write('session', query.repeat(30));
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      const result = await store.grep('session', spill.handle, query, 20);

      expect(result.truncated).toBe(true);
      expect(result.matches.length).toBeLessThan(20);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES);
    } finally {
      await store.dispose();
    }
  });

  it('creates private directories and files', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'fast-spill-mode-test-'));
    const store = new FastAgentSpillStore({
      rootDirectory,
      sweepIntervalMs: 0,
    });
    try {
      store.bindSession('session', 'conversation');
      const spill = await store.write('session', 'private');
      if (!spill.stored) throw new Error('Expected spill to be stored.');
      const [conversationDirectoryName] = readdirSync(rootDirectory);
      expect(conversationDirectoryName).toBeDefined();
      const conversationDirectory = join(
        rootDirectory,
        conversationDirectoryName!,
      );
      const [spillFileName] = readdirSync(conversationDirectory);
      expect(statSync(rootDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(conversationDirectory).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(conversationDirectory, spillFileName!)).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await store.dispose();
    }
  });
});
