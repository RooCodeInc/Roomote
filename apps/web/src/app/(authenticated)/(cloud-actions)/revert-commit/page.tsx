'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useExecuteRevertCommit } from '@/hooks/github';

import {
  CloudActionConfirmation,
  CloudActionMessage,
} from '../cloud-action-confirmation';

function parseParams(raw: {
  repo?: string;
  prNumber?: string;
  commitSha?: string;
}) {
  const { repo, prNumber: prNumberStr, commitSha } = raw;

  if (!repo || !prNumberStr || !commitSha) {
    return null;
  }

  const prNumber = parseInt(prNumberStr, 10);

  if (isNaN(prNumber) || prNumber <= 0) {
    return null;
  }

  return { repo, prNumber, commitSha };
}

export default function Page() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  const params = parseParams({
    repo: searchParams.get('repo') ?? undefined,
    prNumber: searchParams.get('prNumber') ?? undefined,
    commitSha: searchParams.get('commitSha') ?? undefined,
  });
  const executeRevertCommit = useExecuteRevertCommit();

  if (!params) {
    return (
      <CloudActionMessage
        title="Invalid revert request"
        description="This revert link is missing required parameters."
        tone="destructive"
      />
    );
  }

  const validParams = params;

  async function handleConfirm() {
    setError(null);

    try {
      const result = await executeRevertCommit.mutateAsync({
        repo: validParams.repo,
        prNumber: validParams.prNumber,
        commitSha: validParams.commitSha,
      });

      if (result.success) {
        router.push(result.redirectUrl);
        return;
      }

      setError(result.error);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Failed to execute action.',
      );
    }
  }

  return (
    <CloudActionConfirmation
      title="Revert commit"
      description={`This will revert commit ${validParams.commitSha.slice(0, 7)} on ${validParams.repo}#${validParams.prNumber}.`}
      confirmLabel="Revert"
      cancelHref={`https://github.com/${validParams.repo}/pull/${validParams.prNumber}`}
      onConfirm={handleConfirm}
      isPending={executeRevertCommit.isPending}
      error={error}
      variant="destructive"
    />
  );
}
