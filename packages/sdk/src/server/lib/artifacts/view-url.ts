export type ArtifactViewOwner = { taskId: string } | { sessionId: string };

/**
 * Builds the authenticated standalone artifact viewer URL. Keep this shape in
 * sync with getStandaloneArtifactViewUrl in apps/web.
 */
export function buildStandaloneArtifactViewUrl(
  baseUrl: string,
  owner: ArtifactViewOwner,
  path: string,
  version: number,
): string {
  const ownerPath =
    'taskId' in owner
      ? `task/${encodeURIComponent(owner.taskId)}`
      : `session/${encodeURIComponent(owner.sessionId)}`;
  const search = new URLSearchParams({ path, v: String(version) });
  return `${baseUrl.replace(/\/+$/u, '')}/artifacts/${ownerPath}?${search}`;
}
