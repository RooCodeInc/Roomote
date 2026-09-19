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
  let baseUrlEnd = baseUrl.length;
  while (baseUrlEnd > 0 && baseUrl.charCodeAt(baseUrlEnd - 1) === 47) {
    baseUrlEnd -= 1;
  }
  const normalizedBaseUrl = baseUrl.slice(0, baseUrlEnd);
  const ownerPath =
    'taskId' in owner
      ? `task/${encodeURIComponent(owner.taskId)}`
      : `session/${encodeURIComponent(owner.sessionId)}`;
  const search = new URLSearchParams({ path, v: String(version) });
  return `${normalizedBaseUrl}/artifacts/${ownerPath}?${search}`;
}
