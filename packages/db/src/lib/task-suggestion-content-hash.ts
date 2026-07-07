import { createHash } from 'node:crypto';

function normalizeTaskSuggestionHashPart(
  value: string | null | undefined,
): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function buildTaskSuggestionContentHash(params: {
  title: string;
  brief: string;
  targetRepositoryFullName?: string | null;
  repositoryIds?: string[];
}): string {
  const normalizedRepositoryIds = [...(params.repositoryIds ?? [])]
    .map((repositoryId) => normalizeTaskSuggestionHashPart(repositoryId))
    .filter((repositoryId) => repositoryId.length > 0)
    .sort()
    .join(',');

  const fingerprintSource = [
    normalizeTaskSuggestionHashPart(params.title),
    normalizeTaskSuggestionHashPart(params.brief),
    normalizeTaskSuggestionHashPart(params.targetRepositoryFullName),
    normalizedRepositoryIds,
  ].join('\n');

  return createHash('md5').update(fingerprintSource).digest('hex');
}
