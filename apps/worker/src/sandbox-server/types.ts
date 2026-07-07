import type {
  FileDiff,
  GitDiffLine,
  GitDiffResponse,
  GitDiffSummary,
  RepoDiff,
} from '@roomote/types';

export interface CommandExecutionResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  error?: string;
}

export interface StreamChunk {
  type: 'stdout' | 'stderr' | 'exit' | 'timeout';
  data?: string;
  exitCode?: number;
  timestamp: Date;
}

/**
 * A StreamChunk tagged with the originating file path, used by the
 * multiplexed tail subscription to identify which file produced the data.
 */
export interface TaggedStreamChunk extends StreamChunk {
  filePath: string;
}

export interface FileSearchResponse {
  query: string;
  results: FileSearchResult[];
  truncated: boolean;
}

export interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export type {
  FileDiff,
  GitDiffLine,
  GitDiffResponse,
  GitDiffSummary,
  RepoDiff,
};
