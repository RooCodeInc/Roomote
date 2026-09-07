/**
 * Deep link to a task artifact in the task workspace:
 * `/task/<taskId>/artifacts?path=<path>&v=<version>`.
 */
export function getArtifactViewUrl(
  origin: string,
  taskId: string,
  path: string,
  version: number,
): string {
  const search = new URLSearchParams({ path, v: String(version) });
  return `${origin}/task/${encodeURIComponent(taskId)}/artifacts?${search}`;
}

/**
 * Deep link to a Session-owned artifact in the Session Artifacts panel:
 * `/sessions/<sessionId>?artifact=<path>&v=<version>`.
 *
 * The sdk builds the same shape as a plain template in
 * `packages/sdk/src/server/lib/artifacts/create-session-artifact.ts` for
 * `create_artifact` tool results; keep the two in sync.
 */
export function getSessionArtifactViewUrl(
  origin: string,
  sessionId: string,
  path: string,
  version: number,
): string {
  const search = new URLSearchParams({ artifact: path, v: String(version) });
  return `${origin}/sessions/${encodeURIComponent(sessionId)}?${search}`;
}

export type SessionArtifactSelection = {
  path: string;
  /** Requested version; omitted when the link points at the latest version. */
  version?: number;
};

/**
 * Reads the Session artifact deep link (`artifact` and `v`) from the Session
 * page search params. Returns null when no artifact is requested.
 */
export function parseSessionArtifactSearchParams(
  searchParams: URLSearchParams,
): SessionArtifactSelection | null {
  const path = searchParams.get('artifact');
  if (!path) return null;

  const rawVersion = searchParams.get('v');
  const version = rawVersion === null ? Number.NaN : Number(rawVersion);
  return Number.isInteger(version) && version > 0
    ? { path, version }
    : { path };
}
