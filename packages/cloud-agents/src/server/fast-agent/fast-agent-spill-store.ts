import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_SPILL_TTL_MS = 10 * 60_000;
const DEFAULT_CONVERSATION_QUOTA_BYTES = 16 * 1024 * 1024;
const DEFAULT_FILE_QUOTA_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_CONVERSATION = 16;
const FAST_AGENT_SPILL_READ_MAX_BYTES = 5_000;
export const FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES = 28_000;
const FAST_AGENT_SPILL_GREP_MAX_MATCHES = 20;
const FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH = 512;
const FAST_AGENT_SPILL_GREP_CONTEXT_CHARACTERS = 80;

type SpillRecord = {
  byteLength: number;
  conversationId: string;
  expiresAt: number;
  filePath: string;
  handle: string;
};

type ConversationSpills = {
  byteLength: number;
  directory: string;
  handles: Set<string>;
};

type FastAgentSpillStoreOptions = {
  conversationQuotaBytes?: number;
  fileQuotaBytes?: number;
  maxFilesPerConversation?: number;
  now?: () => number;
  rootDirectory?: string;
  sweepIntervalMs?: number;
  ttlMs?: number;
};

type FastAgentSpillWriteResult =
  | {
      stored: true;
      byteLength: number;
      expiresAt: number;
      handle: string;
    }
  | {
      stored: false;
      byteLength: number;
      reason: 'conversation_quota' | 'file_quota' | 'file_count_quota';
    };

type FastAgentSpillReadResult = {
  byteLength: number;
  content: string;
  expiresAt: number;
  handle: string;
  nextOffset: number | null;
  offset: number;
};

type FastAgentSpillGrepResult = {
  byteLength: number;
  expiresAt: number;
  handle: string;
  matches: Array<{ offset: number; preview: string }>;
  query: string;
  truncated: boolean;
};

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function readUtf8Window(
  buffer: Buffer,
  requestedOffset: number,
  requestedLimit: number,
): { content: string; offset: number; nextOffset: number | null } {
  let offset = Math.min(requestedOffset, buffer.length);
  while (offset < buffer.length && isUtf8ContinuationByte(buffer[offset]!)) {
    offset += 1;
  }

  let end = Math.min(buffer.length, offset + requestedLimit);
  if (end < buffer.length) {
    while (end > offset && isUtf8ContinuationByte(buffer[end]!)) {
      end -= 1;
    }
    if (end === offset) {
      end = Math.min(buffer.length, offset + 1);
      while (end < buffer.length && isUtf8ContinuationByte(buffer[end]!)) {
        end += 1;
      }
    }
  }

  return {
    content: new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(offset, end),
    ),
    offset,
    nextOffset: end < buffer.length ? end : null,
  };
}

function readRegularFile(filePath: string, expectedBytes: number): Buffer {
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== expectedBytes) {
      throw new Error('Spill data failed its integrity check.');
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class FastAgentSpillStore {
  private readonly conversationQuotaBytes: number;
  private readonly conversations = new Map<string, ConversationSpills>();
  private readonly fileQuotaBytes: number;
  private readonly handles = new Map<string, SpillRecord>();
  private readonly maxFilesPerConversation: number;
  private readonly now: () => number;
  private readonly rootDirectory: string;
  private readonly sessions = new Map<string, string>();
  private readonly sweepTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;

  constructor(options: FastAgentSpillStoreOptions = {}) {
    this.conversationQuotaBytes =
      options.conversationQuotaBytes ?? DEFAULT_CONVERSATION_QUOTA_BYTES;
    this.fileQuotaBytes = options.fileQuotaBytes ?? DEFAULT_FILE_QUOTA_BYTES;
    this.maxFilesPerConversation =
      options.maxFilesPerConversation ?? DEFAULT_MAX_FILES_PER_CONVERSATION;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SPILL_TTL_MS;
    validatePositiveInteger(
      this.conversationQuotaBytes,
      'conversationQuotaBytes',
    );
    validatePositiveInteger(this.fileQuotaBytes, 'fileQuotaBytes');
    validatePositiveInteger(
      this.maxFilesPerConversation,
      'maxFilesPerConversation',
    );
    validatePositiveInteger(this.ttlMs, 'ttlMs');

    if (options.rootDirectory) {
      this.rootDirectory = options.rootDirectory;
      mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.rootDirectory, 0o700);
    } else {
      this.rootDirectory = mkdtempSync(join(tmpdir(), 'roomote-fast-spills-'));
      chmodSync(this.rootDirectory, 0o700);
    }

    const sweepIntervalMs =
      options.sweepIntervalMs ?? Math.min(this.ttlMs, 60_000);
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(
        () => this.cleanupExpired(),
        sweepIntervalMs,
      );
      this.sweepTimer.unref();
    }
  }

  bindSession(sessionId: string, conversationId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing && existing !== conversationId) {
      throw new Error('The OpenCode session belongs to another conversation.');
    }
    this.sessions.set(sessionId, conversationId);
  }

  unbindSession(sessionId: string, conversationId: string): void {
    if (this.sessions.get(sessionId) === conversationId) {
      this.sessions.delete(sessionId);
    }
  }

  write(sessionId: string, content: string): FastAgentSpillWriteResult {
    this.cleanupExpired();
    const conversationId = this.requireConversation(sessionId);
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length > this.fileQuotaBytes) {
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'file_quota',
      };
    }

    const conversation = this.getOrCreateConversation(conversationId);
    if (conversation.handles.size >= this.maxFilesPerConversation) {
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'file_count_quota',
      };
    }
    if (conversation.byteLength + buffer.length > this.conversationQuotaBytes) {
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'conversation_quota',
      };
    }

    const handle = `spill_${randomBytes(18).toString('base64url')}`;
    const filePath = join(conversation.directory, handle);
    writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
    chmodSync(filePath, 0o600);
    const expiresAt = this.now() + this.ttlMs;
    const record: SpillRecord = {
      byteLength: buffer.length,
      conversationId,
      expiresAt,
      filePath,
      handle,
    };
    this.handles.set(handle, record);
    conversation.handles.add(handle);
    conversation.byteLength += buffer.length;

    return { stored: true, byteLength: buffer.length, expiresAt, handle };
  }

  read(
    sessionId: string,
    handle: string,
    offset = 0,
    limit = FAST_AGENT_SPILL_READ_MAX_BYTES,
  ): FastAgentSpillReadResult {
    validatePositiveInteger(limit, 'limit');
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer.');
    }
    const record = this.requireOwnedRecord(sessionId, handle);
    const buffer = readRegularFile(record.filePath, record.byteLength);
    const window = readUtf8Window(
      buffer,
      offset,
      Math.min(limit, FAST_AGENT_SPILL_READ_MAX_BYTES),
    );
    return {
      byteLength: record.byteLength,
      content: window.content,
      expiresAt: record.expiresAt,
      handle,
      nextOffset: window.nextOffset,
      offset: window.offset,
    };
  }

  grep(
    sessionId: string,
    handle: string,
    query: string,
    maxMatches = 20,
  ): FastAgentSpillGrepResult {
    if (!query || query.length > FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH) {
      throw new Error(
        `query must contain 1-${FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH} characters.`,
      );
    }
    validatePositiveInteger(maxMatches, 'maxMatches');
    const record = this.requireOwnedRecord(sessionId, handle);
    const text = readRegularFile(record.filePath, record.byteLength).toString(
      'utf8',
    );
    const matches: Array<{ offset: number; preview: string }> = [];
    let searchFrom = 0;
    let outputBudgetReached = false;
    const boundedMaxMatches = Math.min(
      maxMatches,
      FAST_AGENT_SPILL_GREP_MAX_MATCHES,
    );

    while (matches.length < boundedMaxMatches) {
      const matchIndex = text.indexOf(query, searchFrom);
      if (matchIndex < 0) break;
      const previewStart = Math.max(
        0,
        matchIndex - FAST_AGENT_SPILL_GREP_CONTEXT_CHARACTERS,
      );
      const previewEnd = Math.min(
        text.length,
        matchIndex + query.length + FAST_AGENT_SPILL_GREP_CONTEXT_CHARACTERS,
      );
      const match = {
        offset: Buffer.byteLength(text.slice(0, matchIndex), 'utf8'),
        preview: text.slice(previewStart, previewEnd),
      };
      const candidateResult = {
        byteLength: record.byteLength,
        expiresAt: record.expiresAt,
        handle,
        matches: [...matches, match],
        query,
        // `false` is the larger final encoding, so passing this check also
        // covers the one-byte-smaller truncated response.
        truncated: false,
      };
      if (
        Buffer.byteLength(JSON.stringify(candidateResult), 'utf8') >
        FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES
      ) {
        outputBudgetReached = true;
        break;
      }
      matches.push(match);
      searchFrom = matchIndex + Math.max(query.length, 1);
    }

    return {
      byteLength: record.byteLength,
      expiresAt: record.expiresAt,
      handle,
      matches,
      query,
      truncated:
        outputBudgetReached ||
        (matches.length === boundedMaxMatches &&
          text.indexOf(query, searchFrom) >= 0),
    };
  }

  cleanupExpired(): void {
    const now = this.now();
    for (const record of [...this.handles.values()]) {
      if (record.expiresAt <= now) this.deleteRecord(record);
    }
  }

  cleanupConversation(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    for (const handle of [...conversation.handles]) {
      const record = this.handles.get(handle);
      if (record) this.deleteRecord(record);
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sessions.clear();
    this.handles.clear();
    this.conversations.clear();
    rmSync(this.rootDirectory, { recursive: true, force: true });
  }

  private requireConversation(sessionId: string): string {
    const conversationId = this.sessions.get(sessionId);
    if (!conversationId) {
      throw new Error('The Fast spill session is no longer active.');
    }
    return conversationId;
  }

  private requireOwnedRecord(sessionId: string, handle: string): SpillRecord {
    this.cleanupExpired();
    const conversationId = this.requireConversation(sessionId);
    const record = this.handles.get(handle);
    if (!record || record.conversationId !== conversationId) {
      throw new Error('The spill handle is unavailable for this conversation.');
    }
    return record;
  }

  private getOrCreateConversation(conversationId: string): ConversationSpills {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const directory = mkdtempSync(join(this.rootDirectory, 'conversation-'));
    chmodSync(directory, 0o700);
    const conversation = {
      byteLength: 0,
      directory,
      handles: new Set<string>(),
    };
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  private deleteRecord(record: SpillRecord): void {
    this.handles.delete(record.handle);
    try {
      unlinkSync(record.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const conversation = this.conversations.get(record.conversationId);
    if (!conversation) return;
    conversation.handles.delete(record.handle);
    conversation.byteLength -= record.byteLength;
    if (conversation.handles.size === 0) {
      this.conversations.delete(record.conversationId);
      rmSync(conversation.directory, { recursive: true, force: true });
    }
  }
}

export const fastAgentSpillStore = new FastAgentSpillStore();

process.once('exit', () => fastAgentSpillStore.dispose());
