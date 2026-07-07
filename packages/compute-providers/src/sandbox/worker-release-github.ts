import {
  buildWorkerReleaseTag,
  compareParsedWorkerReleaseTags,
  getWorkerReleaseTagPrefix,
  normalizeWorkerReleaseSelection,
  parseWorkerReleaseTag,
  selectLatestWorkerReleaseFromList,
  selectLatestWorkerReleaseFromTags,
  type WorkerReleaseSelection,
} from './worker-release-selection';
import { getWorkerReleaseGitHubToken } from './worker-release-github-auth';
import { WORKER_RELEASE_GITHUB_API_BASE } from './worker-release-repository';

const GITHUB_API_VERSION = '2022-11-28';
const RELEASES_PAGE_SIZE = 100;
const MAX_RELEASES_SCAN_PAGES = 50;

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

interface GitHubReleaseAsset {
  name: string;
  url: string;
}

interface GitHubMatchingRef {
  ref: string;
}

interface WorkerReleaseMetadata {
  channel: WorkerReleaseSelection['channel'];
  tag: string;
  version: string;
  assetUrl: string;
}

class GitHubResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(message);
    this.name = 'GitHubResponseError';
  }
}

function isGitHubForbiddenError(error: unknown): error is GitHubResponseError {
  return error instanceof GitHubResponseError && error.status === 403;
}

async function githubFetch(
  url: string,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const token = await getWorkerReleaseGitHubToken();

  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
}

async function fetchReleaseByTag(tag: string): Promise<GitHubRelease> {
  const releaseResponse = await githubFetch(
    `${WORKER_RELEASE_GITHUB_API_BASE}/releases/tags/${tag}`,
  );

  if (!releaseResponse.ok) {
    throw new GitHubResponseError(
      `Selected worker release tag ${tag} has no matching GitHub release: ${releaseResponse.status} ${releaseResponse.statusText}`,
      releaseResponse.status,
      releaseResponse.statusText,
    );
  }

  return (await releaseResponse.json()) as GitHubRelease;
}

async function fetchMatchingWorkerReleaseTags(
  channel: WorkerReleaseSelection['channel'],
): Promise<string[]> {
  const prefix = getWorkerReleaseTagPrefix(channel);
  const response = await githubFetch(
    `${WORKER_RELEASE_GITHUB_API_BASE}/git/matching-refs/tags/${prefix}`,
  );

  if (!response.ok) {
    throw new GitHubResponseError(
      `Failed to fetch worker release tag refs for ${prefix}: ${response.status} ${response.statusText}`,
      response.status,
      response.statusText,
    );
  }

  const refs = (await response.json()) as GitHubMatchingRef[];
  const tagRefPrefix = 'refs/tags/';

  return refs
    .map((item) => item.ref)
    .filter((ref) => ref.startsWith(tagRefPrefix))
    .map((ref) => ref.slice(tagRefPrefix.length));
}

async function fetchReleasePage(page: number): Promise<GitHubRelease[]> {
  const response = await githubFetch(
    `${WORKER_RELEASE_GITHUB_API_BASE}/releases?per_page=${RELEASES_PAGE_SIZE}&page=${page}`,
  );

  if (!response.ok) {
    throw new GitHubResponseError(
      `Failed to fetch worker releases page ${page}: ${response.status} ${response.statusText}`,
      response.status,
      response.statusText,
    );
  }

  return (await response.json()) as GitHubRelease[];
}

async function findReleaseByTagInReleasePages(
  tag: string,
): Promise<GitHubRelease | null> {
  for (let page = 1; page <= MAX_RELEASES_SCAN_PAGES; page += 1) {
    const releases = await fetchReleasePage(page);

    if (releases.length === 0) {
      return null;
    }

    const release = releases.find((entry) => entry.tag_name === tag);

    if (release) {
      return release;
    }

    if (releases.length < RELEASES_PAGE_SIZE) {
      return null;
    }
  }

  throw new Error(
    `Exceeded GitHub releases scan limit while looking for worker release ${tag}`,
  );
}

async function findLatestReleaseInReleasePages(
  channel: WorkerReleaseSelection['channel'],
): Promise<GitHubRelease | null> {
  let latestRelease: GitHubRelease | null = null;
  let latestParsedRelease: ReturnType<typeof parseWorkerReleaseTag> = null;

  for (let page = 1; page <= MAX_RELEASES_SCAN_PAGES; page += 1) {
    const releases = await fetchReleasePage(page);

    if (releases.length === 0) {
      return latestRelease;
    }

    const pageLatest = selectLatestWorkerReleaseFromList(releases, channel);

    if (
      pageLatest &&
      (!latestParsedRelease ||
        compareParsedWorkerReleaseTags(pageLatest, latestParsedRelease) > 0)
    ) {
      latestParsedRelease = pageLatest;
      latestRelease =
        releases.find((entry) => entry.tag_name === pageLatest.tag) ??
        latestRelease;
    }

    if (releases.length < RELEASES_PAGE_SIZE) {
      return latestRelease;
    }
  }

  throw new Error(
    `Exceeded GitHub releases scan limit while looking for the latest ${channel} worker release`,
  );
}

async function fetchReleaseByTagWithFallback(
  tag: string,
): Promise<GitHubRelease> {
  try {
    return await fetchReleaseByTag(tag);
  } catch (error) {
    if (!isGitHubForbiddenError(error)) {
      throw error;
    }

    const release = await findReleaseByTagInReleasePages(tag);

    if (release) {
      return release;
    }

    throw error;
  }
}

function getReleaseAssetUrl(release: GitHubRelease, tag: string): string {
  const assetName = `${tag}.tar.gz`;
  const asset = release.assets.find((item) => item.name === assetName);

  if (!asset) {
    throw new Error(
      `Worker release ${tag} is missing expected archive asset ${assetName}`,
    );
  }

  return asset.url;
}

async function fetchRunnableWorkerReleaseMetadata(
  channel: WorkerReleaseSelection['channel'],
  tag: string,
  version: string,
): Promise<WorkerReleaseMetadata> {
  const release = await fetchReleaseByTagWithFallback(tag);

  return {
    channel,
    tag,
    version,
    assetUrl: getReleaseAssetUrl(release, tag),
  };
}

/**
 * Resolves the runnable worker release for a selection.
 *
 * Pinned versions fetch the exact release by tag. Latest selections discover
 * matching Git tag refs first, choose the numerically latest matching worker
 * tag, then validate that the exact release and archive asset exist.
 */
export async function fetchWorkerReleaseMetadata(
  selection?: Partial<WorkerReleaseSelection>,
): Promise<WorkerReleaseMetadata> {
  const resolvedSelection = normalizeWorkerReleaseSelection(selection);

  if (resolvedSelection.version) {
    const tag = buildWorkerReleaseTag(
      resolvedSelection.version,
      resolvedSelection.channel,
    );

    return fetchRunnableWorkerReleaseMetadata(
      resolvedSelection.channel,
      tag,
      resolvedSelection.version,
    );
  }

  let workerRelease: ReturnType<typeof selectLatestWorkerReleaseFromTags> =
    null;

  try {
    const tags = await fetchMatchingWorkerReleaseTags(
      resolvedSelection.channel,
    );
    workerRelease = selectLatestWorkerReleaseFromTags(
      tags,
      resolvedSelection.channel,
    );
  } catch (error) {
    if (!isGitHubForbiddenError(error)) {
      throw error;
    }

    const fallbackRelease = await findLatestReleaseInReleasePages(
      resolvedSelection.channel,
    );

    if (!fallbackRelease) {
      throw error;
    }

    const parsedFallbackRelease = parseWorkerReleaseTag(
      fallbackRelease.tag_name,
    );

    if (!parsedFallbackRelease) {
      throw error;
    }

    return {
      channel: parsedFallbackRelease.channel,
      tag: parsedFallbackRelease.tag,
      version: parsedFallbackRelease.version,
      assetUrl: getReleaseAssetUrl(fallbackRelease, parsedFallbackRelease.tag),
    };
  }

  if (!workerRelease) {
    throw new Error(
      resolvedSelection.channel === 'preview'
        ? 'No preview worker release tags found on GitHub'
        : 'No worker release tags found on GitHub',
    );
  }

  return fetchRunnableWorkerReleaseMetadata(
    workerRelease.channel,
    workerRelease.tag,
    workerRelease.version,
  );
}

export async function downloadWorkerReleaseArchive(
  assetUrl: string,
): Promise<Buffer> {
  const response = await githubFetch(assetUrl, 'application/octet-stream');

  if (!response.ok) {
    throw new Error(
      `Failed to download worker release archive: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
