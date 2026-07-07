export interface GitDiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface FileDiff {
  path: string;
  lines: GitDiffLine[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
}

export interface RepoDiff {
  repoName: string;
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitDiffSummary {
  repoCount: number;
  changedFileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  hasPendingChanges: boolean;
}

export interface GitDiffResponse {
  repos: RepoDiff[];
  summary: GitDiffSummary;
}
