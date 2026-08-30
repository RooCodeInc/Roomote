import {
  and,
  db,
  eq,
  inArray,
  repositories,
  repositoryAutomationSignals,
} from '@roomote/db/server';
import {
  AUTOMATION_SIGNALS_VERSION,
  listOpenSourceControlPullRequestsForRepository,
} from '@roomote/sdk/server';
import { formatErrorForLog } from '@roomote/types';

/** Overall budget for the remote open-PR listings. The digest is a nicety on
 * the setup submit path, so a slow provider degrades to signals-only (or an
 * empty digest) rather than a slow submit. */
const SETUP_REPO_DIGEST_PR_TIMEOUT_MS = 3_000;
const SETUP_REPO_DIGEST_MAX_REPOSITORIES = 3;
const SETUP_REPO_DIGEST_MAX_OPEN_PRS = 5;
const SETUP_REPO_DIGEST_MAX_TITLE_LENGTH = 120;

type SetupRepoDigestOpenPr = {
  number: number;
  title: string;
  ageDays?: number;
  draft?: boolean;
};

/**
 * Facts-only snapshot of one connected repository for the setup kickoff
 * event. Numbers come from the automation-recommendation signal prefetch
 * (already collected when source control connects); open PRs come from a
 * bounded live listing. Never carries code, diffs, or PR bodies.
 */
type SetupRepoDigestEntry = {
  name: string;
  provider: string;
  openPrCount?: number;
  mergedPrs30d?: number;
  ciFailures30d?: number;
  dependabotAlerts?: number;
  codeqlAlerts?: number;
  mergeConflicts?: number;
  openPrs?: SetupRepoDigestOpenPr[];
};

type ListOpenPullRequests =
  typeof listOpenSourceControlPullRequestsForRepository;

/**
 * Builds the repository digest for the setup session's kickoff event: the
 * most active connected repositories with their collected automation signals
 * and a few open pull requests. Best-effort by design — any failure or
 * timeout returns what was gathered so far (or an empty digest) and never
 * fails the setup submit.
 */
export async function buildSetupRepoDigest({
  listOpenPullRequests = listOpenSourceControlPullRequestsForRepository,
  prListTimeoutMs = SETUP_REPO_DIGEST_PR_TIMEOUT_MS,
}: {
  listOpenPullRequests?: ListOpenPullRequests;
  prListTimeoutMs?: number;
} = {}): Promise<SetupRepoDigestEntry[]> {
  try {
    const activeRepositories = await db.query.repositories.findMany({
      where: eq(repositories.isActive, true),
      columns: {
        id: true,
        sourceControlProvider: true,
        host: true,
        installationId: true,
        externalRepoId: true,
        fullName: true,
        htmlUrl: true,
      },
    });
    if (activeRepositories.length === 0) {
      return [];
    }

    const signalRows = await db
      .select({
        repositoryId: repositoryAutomationSignals.repositoryId,
        payload: repositoryAutomationSignals.payload,
      })
      .from(repositoryAutomationSignals)
      .where(
        and(
          inArray(
            repositoryAutomationSignals.repositoryId,
            activeRepositories.map(({ id }) => id),
          ),
          eq(
            repositoryAutomationSignals.signalsVersion,
            AUTOMATION_SIGNALS_VERSION,
          ),
        ),
      );
    const signalsByRepository = new Map(
      signalRows.map((row) => [row.repositoryId, row.payload]),
    );

    const activity = (repositoryId: string) => {
      const signals = signalsByRepository.get(repositoryId);
      return signals ? signals.mergedPrs30d + signals.openPrs : 0;
    };
    const ranked = [...activeRepositories]
      .sort((a, b) => activity(b.id) - activity(a.id))
      .slice(0, SETUP_REPO_DIGEST_MAX_REPOSITORIES);

    // One shared deadline for all remote listings; on timeout the digest
    // simply omits open PRs. Orphaned in-flight listings resolve harmlessly.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), prListTimeoutMs);
    });
    const listings = await Promise.race([
      Promise.allSettled(
        ranked.map((repository) =>
          listOpenPullRequests({
            repository: {
              id: repository.id,
              sourceControlProvider: repository.sourceControlProvider,
              host: repository.host,
              installationId: repository.installationId,
              externalRepoId: repository.externalRepoId,
              fullName: repository.fullName,
              htmlUrl: repository.htmlUrl,
            },
            provider: repository.sourceControlProvider,
            limit: SETUP_REPO_DIGEST_MAX_OPEN_PRS,
          }),
        ),
      ),
      deadline,
    ]).finally(() => clearTimeout(timer));

    const now = Date.now();
    return ranked.map((repository, index) => {
      const signals = signalsByRepository.get(repository.id);
      const listing = listings?.[index];
      const openPrs =
        listing?.status === 'fulfilled'
          ? listing.value.pullRequests
              .slice(0, SETUP_REPO_DIGEST_MAX_OPEN_PRS)
              .map((pullRequest): SetupRepoDigestOpenPr => {
                const createdAtMs = pullRequest.createdAt
                  ? Date.parse(pullRequest.createdAt)
                  : Number.NaN;
                return {
                  number: pullRequest.number,
                  title: pullRequest.title.slice(
                    0,
                    SETUP_REPO_DIGEST_MAX_TITLE_LENGTH,
                  ),
                  ...(Number.isFinite(createdAtMs)
                    ? {
                        ageDays: Math.max(
                          0,
                          Math.floor((now - createdAtMs) / 86_400_000),
                        ),
                      }
                    : {}),
                  ...(pullRequest.draft ? { draft: true } : {}),
                };
              })
          : undefined;

      return {
        name: repository.fullName,
        provider: repository.sourceControlProvider,
        ...(signals
          ? {
              openPrCount: signals.openPrs,
              mergedPrs30d: signals.mergedPrs30d,
              ciFailures30d: signals.ciFailures30d,
              dependabotAlerts: signals.dependabotAlerts,
              codeqlAlerts: signals.codeqlAlerts,
              mergeConflicts: signals.conflicts,
            }
          : {}),
        ...(openPrs && openPrs.length > 0 ? { openPrs } : {}),
      };
    });
  } catch (error) {
    console.error(
      `[setup] Failed to build the setup repository digest: ${formatErrorForLog(error)}`,
    );
    return [];
  }
}
