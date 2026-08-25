import { chmodSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_SPILL_TTL_MS = 10 * 60_000;
const DEFAULT_CONVERSATION_QUOTA_BYTES = 16 * 1024 * 1024;
const DEFAULT_FILE_QUOTA_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_CONVERSATION = 16;
const DEFAULT_GLOBAL_QUOTA_BYTES = 64 * 1024 * 1024;
const DEFAULT_GLOBAL_FILE_QUOTA = 64;
const FAST_AGENT_SPILL_READ_MAX_BYTES = 5_000;
export const FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES = 12_000;
export const FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES = 1024 * 1024;
const FAST_AGENT_SPILL_GREP_CHUNK_BYTES = 64 * 1024;
const FAST_AGENT_SPILL_GREP_MAX_MATCHES = 20;
const FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH = 512;
const FAST_AGENT_SPILL_GREP_CONTEXT_BYTES = 160;
const PROCESS_SPILL_DIRECTORY_PREFIX = 'process-';

type SpillRecord = {
  byteLength: number;
  conversationId: string;
  expiresAt: number;
  filePath: string;
  handle: string;
};

type ConversationSpills = {
  byteLength: number;
  closed: boolean;
  directory: string;
  fileCount: number;
  handles: Set<string>;
};

type FastAgentSpillStoreOptions = {
  conversationQuotaBytes?: number;
  fileQuotaBytes?: number;
  globalFileQuota?: number;
  globalQuotaBytes?: number;
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
      reason:
        | 'conversation_closed'
        | 'conversation_quota'
        | 'file_quota'
        | 'file_count_quota'
        | 'global_file_quota'
        | 'global_quota';
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
  nextOffset: number | null;
  offset: number;
  query: string;
  scannedBytes: number;
  truncated: boolean;
};

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function validateOffset(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('offset must be a non-negative integer.');
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function decodeUtf8Window(
  buffer: Buffer,
  absoluteOffset: number,
  fileBytes: number,
  requestedLimit: number,
): { content: string; offset: number; nextOffset: number | null } {
  let start = 0;
  while (start < buffer.length && isUtf8ContinuationByte(buffer[start]!)) {
    start += 1;
  }

  let end = Math.min(buffer.length, start + requestedLimit);
  if (absoluteOffset + end < fileBytes) {
    while (end > start && isUtf8ContinuationByte(buffer[end]!)) end -= 1;
    if (end === start && start < buffer.length) {
      end = start + 1;
      while (end < buffer.length && isUtf8ContinuationByte(buffer[end]!)) {
        end += 1;
      }
    }
  }

  const nextOffset = absoluteOffset + end;
  return {
    content: new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(start, end),
    ),
    offset: absoluteOffset + start,
    nextOffset: nextOffset < fileBytes ? nextOffset : null,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function cleanupOrphanedProcessDirectories(
  parentDirectory: string,
  currentDirectory: string,
): Promise<void> {
  try {
    const entries = await readdir(parentDirectory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const match = /^process-(\d+)-/u.exec(entry.name);
        const directory = join(parentDirectory, entry.name);
        if (
          !match ||
          directory === currentDirectory ||
          isProcessAlive(Number(match[1]))
        ) {
          return;
        }
        await rm(directory, { recursive: true, force: true });
      }),
    );
  } catch (error) {
    console.warn(
      '[Fast Agent] Could not clean orphaned spill directories.',
      error,
    );
  }
}

export class FastAgentSpillStore {
  private readonly conversationQuotaBytes: number;
  private readonly conversations = new Map<string, ConversationSpills>();
  private readonly fileQuotaBytes: number;
  private globalByteLength = 0;
  private readonly globalFileQuota: number;
  private globalFiles = 0;
  private readonly globalQuotaBytes: number;
  private readonly handles = new Map<string, SpillRecord>();
  private readonly maxFilesPerConversation: number;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private readonly rootDirectory: string;
  private readonly sessions = new Map<string, string>();
  private readonly sweepTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;

  constructor(options: FastAgentSpillStoreOptions = {}) {
    this.conversationQuotaBytes =
      options.conversationQuotaBytes ?? DEFAULT_CONVERSATION_QUOTA_BYTES;
    this.fileQuotaBytes = options.fileQuotaBytes ?? DEFAULT_FILE_QUOTA_BYTES;
    this.globalFileQuota = options.globalFileQuota ?? DEFAULT_GLOBAL_FILE_QUOTA;
    this.globalQuotaBytes =
      options.globalQuotaBytes ?? DEFAULT_GLOBAL_QUOTA_BYTES;
    this.maxFilesPerConversation =
      options.maxFilesPerConversation ?? DEFAULT_MAX_FILES_PER_CONVERSATION;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SPILL_TTL_MS;
    validatePositiveInteger(
      this.conversationQuotaBytes,
      'conversationQuotaBytes',
    );
    validatePositiveInteger(this.fileQuotaBytes, 'fileQuotaBytes');
    validatePositiveInteger(this.globalFileQuota, 'globalFileQuota');
    validatePositiveInteger(this.globalQuotaBytes, 'globalQuotaBytes');
    validatePositiveInteger(
      this.maxFilesPerConversation,
      'maxFilesPerConversation',
    );
    validatePositiveInteger(this.ttlMs, 'ttlMs');

    if (options.rootDirectory) {
      this.rootDirectory = options.rootDirectory;
      mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.rootDirectory, 0o700);
      this.ready = Promise.resolve();
    } else {
      const parentDirectory = join(tmpdir(), 'roomote-fast-spills');
      mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
      chmodSync(parentDirectory, 0o700);
      this.rootDirectory = mkdtempSync(
        join(
          parentDirectory,
          `${PROCESS_SPILL_DIRECTORY_PREFIX}${process.pid}-`,
        ),
      );
      chmodSync(this.rootDirectory, 0o700);
      // A hard crash cannot run process-exit cleanup. The next process removes
      // directories whose recorded pid no longer exists before accepting data.
      this.ready = cleanupOrphanedProcessDirectories(
        parentDirectory,
        this.rootDirectory,
      );
    }

    const sweepIntervalMs =
      options.sweepIntervalMs ?? Math.min(this.ttlMs, 60_000);
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.cleanupExpired();
      }, sweepIntervalMs);
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

  async write(
    sessionId: string,
    content: string,
  ): Promise<FastAgentSpillWriteResult> {
    await this.ready;
    await this.cleanupExpired();
    const conversationId = this.requireConversation(sessionId);
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length > this.fileQuotaBytes) {
      return { stored: false, byteLength: buffer.length, reason: 'file_quota' };
    }

    const conversation = this.getOrCreateConversation(conversationId);
    if (conversation.fileCount >= this.maxFilesPerConversation) {
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
    if (this.globalFiles >= this.globalFileQuota) {
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'global_file_quota',
      };
    }
    if (this.globalByteLength + buffer.length > this.globalQuotaBytes) {
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'global_quota',
      };
    }

    conversation.byteLength += buffer.length;
    conversation.fileCount += 1;
    this.globalByteLength += buffer.length;
    this.globalFiles += 1;
    const handle = `spill_${randomBytes(18).toString('base64url')}`;
    const filePath = join(conversation.directory, handle);
    try {
      const descriptor = await open(
        filePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await descriptor.writeFile(buffer);
        await descriptor.chmod(0o600);
      } finally {
        await descriptor.close();
      }
    } catch (error) {
      if (!conversation.closed)
        this.releaseReservation(conversation, buffer.length);
      await rm(filePath, { force: true });
      throw error;
    }

    if (conversation.closed) {
      await rm(filePath, { force: true });
      return {
        stored: false,
        byteLength: buffer.length,
        reason: 'conversation_closed',
      };
    }

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
    return { stored: true, byteLength: buffer.length, expiresAt, handle };
  }

  async read(
    sessionId: string,
    handle: string,
    offset = 0,
    limit = FAST_AGENT_SPILL_READ_MAX_BYTES,
  ): Promise<FastAgentSpillReadResult> {
    validatePositiveInteger(limit, 'limit');
    validateOffset(offset);
    const opened = await this.openOwnedRecord(sessionId, handle);
    try {
      const boundedLimit = Math.min(limit, FAST_AGENT_SPILL_READ_MAX_BYTES);
      const position = Math.min(offset, opened.record.byteLength);
      const readBytes = Math.min(
        opened.record.byteLength - position,
        boundedLimit + 4,
      );
      const buffer = Buffer.alloc(readBytes);
      const { bytesRead } = await opened.descriptor.read(
        buffer,
        0,
        readBytes,
        position,
      );
      const window = decodeUtf8Window(
        buffer.subarray(0, bytesRead),
        position,
        opened.record.byteLength,
        boundedLimit,
      );
      return {
        byteLength: opened.record.byteLength,
        content: window.content,
        expiresAt: opened.record.expiresAt,
        handle,
        nextOffset: window.nextOffset,
        offset: window.offset,
      };
    } finally {
      await opened.descriptor.close();
    }
  }

  async grep(
    sessionId: string,
    handle: string,
    query: string,
    maxMatches = 20,
    offset = 0,
  ): Promise<FastAgentSpillGrepResult> {
    if (!query || query.length > FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH) {
      throw new Error(
        `query must contain 1-${FAST_AGENT_SPILL_GREP_MAX_QUERY_LENGTH} characters.`,
      );
    }
    validatePositiveInteger(maxMatches, 'maxMatches');
    validateOffset(offset);
    const queryBuffer = Buffer.from(query, 'utf8');
    const opened = await this.openOwnedRecord(sessionId, handle);
    try {
      const startOffset = Math.min(offset, opened.record.byteLength);
      const scanEnd = Math.min(
        opened.record.byteLength,
        startOffset + FAST_AGENT_SPILL_GREP_MAX_SCAN_BYTES,
      );
      const readEnd = Math.min(
        opened.record.byteLength,
        scanEnd + Math.max(0, queryBuffer.length - 1),
      );
      const boundedMaxMatches = Math.min(
        maxMatches,
        FAST_AGENT_SPILL_GREP_MAX_MATCHES,
      );
      const matches: Array<{ offset: number; preview: string }> = [];
      let carry = Buffer.alloc(0);
      let position = startOffset;
      let nextMatchOffset = startOffset;
      let nextOffset: number | null = null;

      search: while (position < readEnd) {
        const chunkBytes = Math.min(
          FAST_AGENT_SPILL_GREP_CHUNK_BYTES,
          readEnd - position,
        );
        const chunk = Buffer.alloc(chunkBytes);
        const { bytesRead } = await opened.descriptor.read(
          chunk,
          0,
          chunkBytes,
          position,
        );
        if (bytesRead === 0) break;
        const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        const combinedOffset = position - carry.length;
        let searchFrom = 0;
        while (searchFrom <= combined.length - queryBuffer.length) {
          const matchIndex = combined.indexOf(queryBuffer, searchFrom);
          if (matchIndex < 0) break;
          const matchOffset = combinedOffset + matchIndex;
          searchFrom = matchIndex + Math.max(queryBuffer.length, 1);
          if (matchOffset < nextMatchOffset || matchOffset >= scanEnd) continue;
          const preview = await this.readPreview(
            opened.descriptor,
            opened.record.byteLength,
            matchOffset,
            queryBuffer.length,
          );
          const match = { offset: matchOffset, preview };
          const candidate = {
            byteLength: opened.record.byteLength,
            expiresAt: opened.record.expiresAt,
            handle,
            matches: [...matches, match],
            nextOffset: matchOffset + queryBuffer.length,
            offset: startOffset,
            query,
            scannedBytes: scanEnd - startOffset,
            truncated: false,
          };
          if (
            Buffer.byteLength(JSON.stringify(candidate), 'utf8') >
            FAST_AGENT_SPILL_GREP_RESULT_MAX_BYTES
          ) {
            nextOffset = matchOffset;
            break search;
          }
          matches.push(match);
          nextMatchOffset = matchOffset + Math.max(queryBuffer.length, 1);
          if (matches.length >= boundedMaxMatches) {
            nextOffset = nextMatchOffset;
            break search;
          }
        }
        const carryBytes = Math.min(
          Math.max(0, queryBuffer.length - 1),
          combined.length,
        );
        carry = combined.subarray(combined.length - carryBytes);
        position += bytesRead;
      }

      if (nextOffset === null && scanEnd < opened.record.byteLength) {
        nextOffset = scanEnd;
      }
      return {
        byteLength: opened.record.byteLength,
        expiresAt: opened.record.expiresAt,
        handle,
        matches,
        nextOffset,
        offset: startOffset,
        query,
        scannedBytes: scanEnd - startOffset,
        truncated: nextOffset !== null,
      };
    } finally {
      await opened.descriptor.close();
    }
  }

  async cleanupExpired(): Promise<void> {
    await this.ready;
    const now = this.now();
    for (const record of [...this.handles.values()]) {
      if (record.expiresAt <= now) await this.removeRecord(record);
    }
  }

  async cleanupConversation(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.closed = true;
    this.conversations.delete(conversationId);
    for (const handle of conversation.handles) this.handles.delete(handle);
    this.globalByteLength -= conversation.byteLength;
    this.globalFiles -= conversation.fileCount;
    await rm(conversation.directory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const conversation of this.conversations.values()) {
      conversation.closed = true;
    }
    this.sessions.clear();
    this.handles.clear();
    this.conversations.clear();
    this.globalByteLength = 0;
    this.globalFiles = 0;
    await rm(this.rootDirectory, { recursive: true, force: true });
  }

  disposeSync(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const conversation of this.conversations.values()) {
      conversation.closed = true;
    }
    rmSync(this.rootDirectory, { recursive: true, force: true });
  }

  private requireConversation(sessionId: string): string {
    const conversationId = this.sessions.get(sessionId);
    if (!conversationId) {
      throw new Error('The Fast spill session is no longer active.');
    }
    return conversationId;
  }

  private async openOwnedRecord(sessionId: string, handle: string) {
    await this.ready;
    await this.cleanupExpired();
    const conversationId = this.requireConversation(sessionId);
    const record = this.handles.get(handle);
    if (!record || record.conversationId !== conversationId) {
      throw new Error('The spill handle is unavailable for this conversation.');
    }
    const descriptor = await open(
      record.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await descriptor.stat();
      if (!stat.isFile() || stat.size !== record.byteLength) {
        throw new Error('Spill data failed its integrity check.');
      }
      return { descriptor, record };
    } catch (error) {
      await descriptor.close();
      throw error;
    }
  }

  private getOrCreateConversation(conversationId: string): ConversationSpills {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const directory = mkdtempSync(join(this.rootDirectory, 'conversation-'));
    chmodSync(directory, 0o700);
    const conversation = {
      byteLength: 0,
      closed: false,
      directory,
      fileCount: 0,
      handles: new Set<string>(),
    };
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  private releaseReservation(
    conversation: ConversationSpills,
    byteLength: number,
  ): void {
    conversation.byteLength -= byteLength;
    conversation.fileCount -= 1;
    this.globalByteLength -= byteLength;
    this.globalFiles -= 1;
    if (conversation.fileCount === 0) {
      conversation.closed = true;
      for (const [conversationId, candidate] of this.conversations) {
        if (candidate === conversation)
          this.conversations.delete(conversationId);
      }
      void rm(conversation.directory, { recursive: true, force: true });
    }
  }

  private async removeRecord(record: SpillRecord): Promise<void> {
    if (!this.handles.delete(record.handle)) return;
    const conversation = this.conversations.get(record.conversationId);
    if (conversation && !conversation.closed) {
      conversation.handles.delete(record.handle);
      conversation.byteLength -= record.byteLength;
      conversation.fileCount -= 1;
      this.globalByteLength -= record.byteLength;
      this.globalFiles -= 1;
      if (conversation.fileCount === 0) {
        conversation.closed = true;
        this.conversations.delete(record.conversationId);
      }
    }
    await rm(record.filePath, { force: true });
    if (conversation?.closed) {
      await rm(conversation.directory, { recursive: true, force: true });
    }
  }

  private async readPreview(
    descriptor: Awaited<ReturnType<typeof open>>,
    fileBytes: number,
    matchOffset: number,
    queryBytes: number,
  ): Promise<string> {
    const position = Math.max(
      0,
      matchOffset - FAST_AGENT_SPILL_GREP_CONTEXT_BYTES,
    );
    const previewBytes = queryBytes + FAST_AGENT_SPILL_GREP_CONTEXT_BYTES * 2;
    const readBytes = Math.min(fileBytes - position, previewBytes + 4);
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await descriptor.read(buffer, 0, readBytes, position);
    return decodeUtf8Window(
      buffer.subarray(0, bytesRead),
      position,
      fileBytes,
      previewBytes,
    ).content;
  }
}

export const fastAgentSpillStore = new FastAgentSpillStore();

process.once('exit', () => {
  fastAgentSpillStore.disposeSync();
});
