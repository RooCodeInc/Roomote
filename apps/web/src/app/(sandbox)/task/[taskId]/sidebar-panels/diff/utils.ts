import type { BundledLanguage } from 'shiki';

import { type FileDiff } from '../../hooks';
import { type DiffLine } from '@/components/ai-elements';

/**
 * Map the worker's GitDiffLine (which includes 'header') to the
 * DiffLine type used by CodeBlockDiffContent (which only accepts
 * 'add' | 'remove' | 'context').
 */
export function toDiffLines(file: FileDiff): DiffLine[] {
  const contentLines = file.lines
    .filter((l) => l.type !== 'header')
    .map((l) => ({
      type: l.type as DiffLine['type'],
      content: l.content,
    }));

  if (contentLines.length > 0) {
    return contentLines;
  }

  // Binary/untracked files can produce header-only diffs.
  // Preserve them as context so the file still renders in the panel.
  return file.lines
    .filter((l) => l.type === 'header')
    .map((l) => ({
      type: 'context' as const,
      content: l.content,
    }));
}

/** Create a stable DOM id from a repo name and file path. */
export function fileId(repoName: string, path: string) {
  return `diff-${repoName.replace(/[^a-zA-Z0-9-_]/g, '-')}-${path.replace(/[^a-zA-Z0-9-_]/g, '-')}`;
}

const EXT_MAP: Record<string, BundledLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'dockerfile',
  makefile: 'make',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  prisma: 'prisma',
};

/**
 * Infer a shiki-compatible BundledLanguage from a file path extension.
 */
export function inferLanguageFromPath(path: string): BundledLanguage {
  const filename = path.split('/').pop() ?? '';

  const lowerFilename = filename.toLowerCase();

  if (lowerFilename === 'dockerfile') {
    return 'dockerfile';
  }

  if (lowerFilename === 'makefile') {
    return 'make';
  }

  const ext = filename.split('.').pop()?.toLowerCase();

  return EXT_MAP[ext ?? ''] ?? ('text' as BundledLanguage);
}
