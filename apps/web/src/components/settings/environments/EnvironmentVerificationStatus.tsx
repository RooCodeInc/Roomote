'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import {
  AlertCircle,
  Badge,
  BasicTooltip,
  Check,
  CheckCircle2,
  Loader2,
  X,
} from '@/components/system';
import { ArrowUpRight, CircleQuestionMark, ExternalLink } from 'lucide-react';
import { Arrow } from '@radix-ui/react-tooltip';
import { ArrowTopRightIcon } from '@radix-ui/react-icons';

type EnvironmentVerificationState =
  | 'verified'
  | 'in_progress'
  | 'failed'
  | 'configured';

export function getEnvironmentVerificationState(
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

export function EnvironmentVerificationBadge({
  env,
}: {
  env: EnvironmentWithMeta;
}) {
  const state = getEnvironmentVerificationState(env);
  const badgeClassName = env.verificationTaskId
    ? 'gap-1 cursor-pointer'
    : 'gap-1';
  const wrapBadge = (badge: ReactNode) =>
    env.verificationTaskId ? (
      <Link
        href={`/task/${env.verificationTaskId}`}
        className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Open verification task"
      >
        {badge}
      </Link>
    ) : (
      badge
    );

  switch (state) {
    case 'verified':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              <p>
                {env.name} is verified and ready to use. Click to see the
                verification task.
              </p>
              {env.verifiedAt ? (
                <p className="text-card/70">
                  Verified{' '}
                  {formatDistanceToNow(env.verifiedAt, { addSuffix: true })}
                </p>
              ) : null}
            </div>
          }
        >
          {wrapBadge(
            <Badge variant="success" className={badgeClassName}>
              <Check className="size-3" />
              Verified
              <ArrowUpRight />
            </Badge>,
          )}
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
          {wrapBadge(
            <Badge variant="secondary" className={badgeClassName}>
              <Loader2 className="size-3 animate-spin" />
              Verification in progress
              <ArrowUpRight />
            </Badge>,
          )}
        </BasicTooltip>
      );
    case 'failed':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              Roomote could not verify that this environment works. It is still
              usable; retry verification after checking the configuration.
              {env.verificationError ? (
                <p className="mt-1 text-card/70">{env.verificationError}</p>
              ) : null}
            </div>
          }
        >
          {wrapBadge(
            <Badge variant="destructive" className={badgeClassName}>
              <X className="size-3" />
              Verification failed
              <ArrowUpRight />
            </Badge>,
          )}
        </BasicTooltip>
      );
    case 'configured':
    default:
      return (
        <BasicTooltip
          content={
            <div className="text-sm max-w-md">
              {env.name} is configured but has not been verified for its current
              configuration. Click to see the verification task.
            </div>
          }
        >
          {wrapBadge(
            <Badge variant="warning" className={badgeClassName}>
              <CircleQuestionMark className="size-3" />
              Configured
              <ArrowUpRight />
            </Badge>,
          )}
        </BasicTooltip>
      );
  }
}
