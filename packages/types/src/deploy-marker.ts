import { formatSingleLineLog } from './logging';

export type RoomoteReleaseSource =
  | 'vercel_git_commit_sha'
  | 'github_sha'
  | 'release_version'
  | 'worker_release_tag'
  | 'worker_commit';

export interface RoomoteDeployMarker {
  roomote_signal: 'deploy_marker';
  roomote_service: string;
  roomote_app_env?: string;
  roomote_node_env?: string;
  roomote_release?: string;
  roomote_release_source?: RoomoteReleaseSource;
  roomote_commit_sha?: string;
  roomote_vercel_deployment_id?: string;
  roomote_worker_release_tag?: string;
  roomote_worker_version?: string;
  roomote_worker_commit?: string;
}

function readTrimmedEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveRoomoteDeployMarkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<RoomoteDeployMarker, 'roomote_service' | 'roomote_signal'> {
  const vercelGitCommitSha = readTrimmedEnvValue(env, 'VERCEL_GIT_COMMIT_SHA');
  const githubSha = readTrimmedEnvValue(env, 'GITHUB_SHA');
  const releaseVersion = readTrimmedEnvValue(env, 'RELEASE_VERSION');

  const roomote_release =
    vercelGitCommitSha || githubSha || releaseVersion || undefined;
  const roomote_release_source = vercelGitCommitSha
    ? 'vercel_git_commit_sha'
    : githubSha
      ? 'github_sha'
      : releaseVersion
        ? 'release_version'
        : undefined;

  return {
    roomote_app_env:
      readTrimmedEnvValue(env, 'ROOMOTE_APP_ENV') ||
      readTrimmedEnvValue(env, 'APP_ENV') ||
      readTrimmedEnvValue(env, 'NODE_ENV') ||
      undefined,
    roomote_node_env: readTrimmedEnvValue(env, 'NODE_ENV'),
    roomote_release,
    roomote_release_source,
    roomote_commit_sha: vercelGitCommitSha || githubSha || undefined,
    roomote_vercel_deployment_id: readTrimmedEnvValue(
      env,
      'VERCEL_DEPLOYMENT_ID',
    ),
  };
}

export function buildRoomoteDeployMarker(args: {
  service: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<RoomoteDeployMarker>;
}): RoomoteDeployMarker {
  const { env = process.env, overrides } = args;

  return {
    roomote_signal: 'deploy_marker',
    roomote_service: args.service,
    ...resolveRoomoteDeployMarkerEnv(env),
    ...overrides,
  };
}

export function formatRoomoteDeployMarker(marker: RoomoteDeployMarker): string {
  return formatSingleLineLog(
    '[deploy-marker]',
    marker as unknown as Record<string, unknown>,
  );
}
