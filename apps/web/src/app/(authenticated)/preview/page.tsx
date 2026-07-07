import { hasRepoAccess } from '@/lib/server';

import { AccessDenied } from './AccessDenied';
import { PreviewEnvironment } from './PreviewEnvironment';

type Props = {
  searchParams: Promise<{
    repo?: string;
    sha?: string;
    pr?: string;
    branch?: string;
  }>;
};

function parseParams(raw: {
  repo?: string;
  sha?: string;
  pr?: string;
  branch?: string;
}) {
  const { repo, sha, pr: prStr, branch } = raw;

  if (!repo || !sha || !prStr || !branch) {
    return null;
  }

  if (!repo.includes('/')) {
    return null;
  }

  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }

  const pr = parseInt(prStr, 10);

  if (isNaN(pr) || pr <= 0) {
    return null;
  }

  return { repo, sha, pr, branch };
}

export default async function PreviewPage(props: Props) {
  const rawParams = await props.searchParams;
  const params = parseParams(rawParams);

  if (!params) {
    return <AccessDenied />;
  }

  // Verify the current user has access to the repository before rendering.
  const canAccess = await hasRepoAccess(params.repo);

  if (!canAccess) {
    return <AccessDenied />;
  }

  return (
    <PreviewEnvironment
      repo={params.repo}
      sha={params.sha}
      pr={params.pr}
      branch={params.branch}
    />
  );
}
