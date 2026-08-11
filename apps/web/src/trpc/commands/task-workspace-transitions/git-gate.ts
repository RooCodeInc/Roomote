import type { WorkspaceGitManifest } from '@roomote/types';

export function getGitBlockReason(
  manifest: WorkspaceGitManifest,
): string | null {
  if (manifest.repositories.length === 0) {
    return 'No Git repositories were found in the current workspace.';
  }

  const dirty = manifest.repositories.filter(
    (repository) => repository.dirtyPaths.length > 0,
  );
  if (dirty.length > 0) {
    return `Commit or discard local changes before switching (${dirty.map((repository) => repository.repository).join(', ')}).`;
  }

  const unpushed = manifest.repositories.filter(
    (repository) => repository.upstream === null || repository.ahead > 0,
  );
  if (unpushed.length > 0) {
    return `Push every current branch before switching (${unpushed.map((repository) => repository.repository).join(', ')}).`;
  }

  return null;
}
