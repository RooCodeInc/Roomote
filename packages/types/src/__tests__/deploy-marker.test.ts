import {
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
  resolveRoomoteDeployMarkerEnv,
} from '../deploy-marker';

describe('deploy marker helpers', () => {
  it('prefers Vercel commit sha over other release inputs', () => {
    expect(
      resolveRoomoteDeployMarkerEnv({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        VERCEL_GIT_COMMIT_SHA: 'vercel-sha',
        GITHUB_SHA: 'github-sha',
        RELEASE_VERSION: 'release-version',
      }),
    ).toMatchObject({
      roomote_app_env: 'production',
      roomote_node_env: 'production',
      roomote_release: 'vercel-sha',
      roomote_release_source: 'vercel_git_commit_sha',
      roomote_commit_sha: 'vercel-sha',
    });
  });

  it('includes deployment metadata in the marker', () => {
    expect(
      buildRoomoteDeployMarker({
        service: 'api',
        env: {
          NODE_ENV: 'production',
          APP_ENV: 'production',
          RELEASE_VERSION: 'release-version',
          VERCEL_DEPLOYMENT_ID: 'dpl_123',
        },
      }),
    ).toMatchObject({
      roomote_signal: 'deploy_marker',
      roomote_service: 'api',
      roomote_release: 'release-version',
      roomote_release_source: 'release_version',
      roomote_vercel_deployment_id: 'dpl_123',
    });
  });

  it('formats a searchable single-line deploy marker', () => {
    const marker = buildRoomoteDeployMarker({
      service: 'preview-proxy',
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        GITHUB_SHA: 'abc123',
      },
    });

    expect(formatRoomoteDeployMarker(marker)).toBe(
      '[deploy-marker] roomote_signal="deploy_marker" roomote_service="preview-proxy" roomote_app_env="production" roomote_node_env="production" roomote_release="abc123" roomote_release_source="github_sha" roomote_commit_sha="abc123"',
    );
  });
});
