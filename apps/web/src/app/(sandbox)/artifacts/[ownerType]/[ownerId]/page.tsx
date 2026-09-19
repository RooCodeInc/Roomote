import { notFound } from 'next/navigation';

import { StandaloneArtifactViewer } from './StandaloneArtifactViewer';

type StandaloneArtifactPageProps = {
  params: Promise<{ ownerType: string; ownerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function getVersion(value: string | string[] | undefined): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default async function StandaloneArtifactPage({
  params,
  searchParams,
}: StandaloneArtifactPageProps) {
  const [{ ownerType, ownerId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const path = typeof query.path === 'string' ? query.path : null;
  const version = getVersion(query.v);

  if (ownerType !== 'task' && ownerType !== 'session') {
    notFound();
  }

  const owner =
    ownerType === 'task' ? { taskId: ownerId } : { sessionId: ownerId };

  return (
    <StandaloneArtifactViewer owner={owner} path={path} version={version} />
  );
}
