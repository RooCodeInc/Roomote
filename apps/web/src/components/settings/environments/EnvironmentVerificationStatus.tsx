'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import { useRetryEnvironmentVerification } from '@/hooks/environments';
import {
  AlertCircle,
  Badge,
  BasicTooltip,
  Button,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from '@/components/system';

type EnvironmentVerificationState =
  | 'verified'
  | 'in_progress'
  | 'failed'
  | 'configured';

function getEnvironmentVerificationState(
  environment: Pick<
    EnvironmentWithMeta,
    | 'isVerified'
    | 'verificationTaskId'
    | 'verificationTaskActive'
    | 'verificationError'
  >,
): EnvironmentVerificationState {
  if (environment.isVerified) {
    return 'verified';
  }

  if (environment.verificationError) {
    return 'failed';
  }

  // Only show "in progress" while the verification task actually has an active
  // run. A stale task id from a crashed or unreported attempt falls back to
  // "configured" instead of appearing stuck forever.
  if (environment.verificationTaskId && environment.verificationTaskActive) {
    return 'in_progress';
  }

  return 'configured';
}

function VerificationBadge({ env }: { env: EnvironmentWithMeta }) {
  const state = getEnvironmentVerificationState(env);

  switch (state) {
    case 'verified':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              <p>Your environment is verified and ready to use.</p>
              {env.verifiedAt ? (
                <p className="text-card/70">
                  Verified{' '}
                  {formatDistanceToNow(env.verifiedAt, { addSuffix: true })}
                </p>
              ) : null}
            </div>
          }
        >
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="size-3" />
            Verified
          </Badge>
        </BasicTooltip>
      );
    case 'in_progress':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              Roomote is checking that this environment works. You can keep
              using it while verification finishes.
            </div>
          }
        >
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="size-3 animate-spin" />
            Verification in progress
          </Badge>
        </BasicTooltip>
      );
    case 'failed':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              Roomote could not verify that this environment works. It is still
              usable; retry verification after checking the configuration.
            </div>
          }
        >
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="size-3" />
            Verification failed
          </Badge>
        </BasicTooltip>
      );
    case 'configured':
    default:
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              This environment is configured but has not been verified for its
              current configuration.
            </div>
          }
        >
          <Badge variant="secondary" className="gap-1">
            Configured
          </Badge>
        </BasicTooltip>
      );
  }
}

/**
 * Renders the verification status for an environment, its latest failure
 * message when present, a link to the related verification task, and a Retry
 * verification action.
 */
export function EnvironmentVerificationStatus({
  env,
}: {
  env: EnvironmentWithMeta;
}) {
  const retryVerification = useRetryEnvironmentVerification();
  const state = getEnvironmentVerificationState(env);
  const isRetrying =
    retryVerification.isPending &&
    retryVerification.variables?.environmentId === env.id;
  const inProgress = state === 'in_progress';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Verification ·</span>
        <VerificationBadge env={env} />
        {env.verificationTaskId ? (
          <Link
            href={`/task/${env.verificationTaskId}`}
            className="text-xs font-medium underline underline-offset-4 text-muted-foreground hover:text-foreground"
          >
            View task
          </Link>
        ) : null}
        {!inProgress ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={isRetrying}
            onClick={() => retryVerification.mutate({ environmentId: env.id })}
          >
            {isRetrying ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Retry verification
          </Button>
        ) : null}
      </div>
      {state === 'failed' && env.verificationError ? (
        <p className="text-xs text-destructive break-words">
          {env.verificationError}
        </p>
      ) : null}
    </div>
  );
}
