import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
  it('shares handles between parent and child sessions in one conversation', () => {
    const store = createStore();
    try {
      store.bindSession('child-session', 'conversation-a');
      store.bindSession('parent-session', 'conversation-a');
      const spill = store.write('child-session', 'child output');
      expect(spill.stored).toBe(true);
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      expect(store.read('parent-session', spill.handle)).toMatchObject({
        content: 'child output',
        handle: spill.handle,
        offset: 0,
        nextOffset: null,
      });
    } finally {
      store.dispose();
    }
  });

  it('rejects handles owned by another conversation', () => {
    const store = createStore();
    try {
      store.bindSession('owner-session', 'conversation-a');
      store.bindSession('other-session', 'conversation-b');
      const spill = store.write('owner-session', 'private output');
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      expect(() => store.read('other-session', spill.handle)).toThrow(
        'unavailable for this conversation',
      );
      expect(() =>
        store.grep('other-session', spill.handle, 'private'),
      ).toThrow('unavailable for this conversation');
    } finally {
      store.dispose();
    }
  });

  it('expires handles and removes their files', () => {
    let now = 100;
    const store = createStore({ now: () => now, ttlMs: 10 });
    try {
      store.bindSession('session', 'conversation');
      const spill = store.write('session', 'temporary output');
      if (!spill.stored) throw new Error('Expected spill to be stored.');
      now = 110;

      expect(() => store.read('session', spill.handle)).toThrow(
        'unavailable for this conversation',
      );
    } finally {
      store.dispose();
    }
  });

  it('removes every handle when a conversation ends', () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const first = store.write('session', 'first');
      const second = store.write('session', 'second');
      if (!first.stored || !second.stored) {
        throw new Error('Expected spills to be stored.');
      }

      store.cleanupConversation('conversation');

      expect(() => store.read('session', first.handle)).toThrow(
        'unavailable for this conversation',
      );
      expect(() => store.read('session', second.handle)).toThrow(
        'unavailable for this conversation',
      );
    } finally {
      store.dispose();
    }
  });

  it('enforces file, conversation-byte, and file-count quotas', () => {
    const fileStore = createStore({ fileQuotaBytes: 4 });
    const byteStore = createStore({
      conversationQuotaBytes: 8,
      fileQuotaBytes: 8,
    });
    const countStore = createStore({ maxFilesPerConversation: 1 });
    try {
      fileStore.bindSession('file-session', 'file-conversation');
      expect(fileStore.write('file-session', '12345')).toMatchObject({
        stored: false,
        reason: 'file_quota',
      });

      byteStore.bindSession('byte-session', 'byte-conversation');
      expect(byteStore.write('byte-session', '12345')).toMatchObject({
        stored: true,
      });
      expect(byteStore.write('byte-session', '6789')).toMatchObject({
        stored: false,
        reason: 'conversation_quota',
      });

      countStore.bindSession('count-session', 'count-conversation');
      expect(countStore.write('count-session', 'first')).toMatchObject({
        stored: true,
      });
      expect(countStore.write('count-session', 'second')).toMatchObject({
        stored: false,
        reason: 'file_count_quota',
      });
    } finally {
      fileStore.dispose();
      byteStore.dispose();
      countStore.dispose();
    }
  });

  it('returns valid UTF-8 windows at multibyte boundaries', () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const spill = store.write('session', 'A😀B');
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      expect(store.read('session', spill.handle, 1, 2)).toMatchObject({
        content: '😀',
        offset: 1,
        nextOffset: 5,
      });
      expect(store.read('session', spill.handle, 2, 5)).toMatchObject({
        content: 'B',
        offset: 5,
        nextOffset: null,
      });
    } finally {
      store.dispose();
    }
  });

  it('searches literal text with bounded matches and byte offsets', () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const spill = store.write('session', '😀 target one\ntarget two');
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      expect(store.grep('session', spill.handle, 'target', 1)).toMatchObject({
        handle: spill.handle,
        matches: [{ offset: 5, preview: expect.stringContaining('target') }],
        query: 'target',
        truncated: true,
      });
    } finally {
      store.dispose();
    }
  });

  it('keeps heavily escaped grep results within the structured byte budget', () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const query = '\0'.repeat(512);
      const spill = store.write('session', query.repeat(30));
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      const result = store.grep('session', spill.handle, query, 20);

      expect(result.truncated).toBe(true);
      expect(result.matches.length).toBeLessThan(20);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES);
    } finally {
      store.dispose();
    }
  });

  it('budgets the larger non-truncated grep encoding', () => {
    const store = createStore();
    try {
      store.bindSession('session', 'conversation');
      const query = '\0'.repeat(80);
      const spill = store.write('session', query.repeat(18));
      if (!spill.stored) throw new Error('Expected spill to be stored.');

      const result = store.grep('session', spill.handle, query, 20);
      const serializedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

      expect(result.truncated).toBe(false);
      expect(serializedBytes).toBeGreaterThan(25_000);
      expect(serializedBytes).toBeLessThanOrEqual(
        FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES,
      );
    } finally {
      store.dispose();
    }
  });

  it('creates private directories and files', () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'fast-spill-mode-test-'));
    const store = new FastAgentSpillStore({
      rootDirectory,
      sweepIntervalMs: 0,
    });
    try {
      store.bindSession('session', 'conversation');
      const spill = store.write('session', 'private');
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
      store.dispose();
    }
  });
});
