'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import {
  ArrowUpRightIcon,
  Badge,
  BasicTooltip,
  Check,
  HelpCircle,
  Loader2,
  type LucideIcon,
  X,
} from '@/components/system';

export type EnvironmentVerificationState =
  | 'verified'
  | 'in_progress'
  | 'failed'
  | 'configured';

export const environmentVerificationDisplay: Record<
  EnvironmentVerificationState,
  {
    Icon: LucideIcon;
    label: string;
    iconClassName?: string;
  }
> = {
  verified: {
    Icon: Check,
    label: 'Verified',
  },
  in_progress: {
    Icon: Loader2,
    label: 'Verification in progress',
    iconClassName: 'animate-spin',
  },
  failed: {
    Icon: X,
    label: 'Verification failed',
  },
  configured: {
    Icon: HelpCircle,
    label: 'Configured',
  },
};

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
  const { Icon, iconClassName, label } = environmentVerificationDisplay[state];
  const hasVerificationTask = Boolean(env.verificationTaskId);
  const badgeClassName = hasVerificationTask ? 'gap-1 cursor-pointer' : 'gap-1';
  const wrapBadge = (badge: ReactNode) =>
    hasVerificationTask ? (
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
                {env.name} is verified and ready to use.
                {hasVerificationTask
                  ? ' Click to see the verification task.'
                  : ''}
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
              <Icon
                className={['size-3', iconClassName].filter(Boolean).join(' ')}
              />
              {label}
              {hasVerificationTask ? <ArrowUpRightIcon /> : null}
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
              <Icon
                className={['size-3', iconClassName].filter(Boolean).join(' ')}
              />
              {label}
              {hasVerificationTask ? <ArrowUpRightIcon /> : null}
            </Badge>,
          )}
        </BasicTooltip>
      );
    case 'failed':
      return (
        <BasicTooltip
          content={
            <div className="text-sm max-w-lg">
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
              <Icon
                className={['size-3', iconClassName].filter(Boolean).join(' ')}
              />
              {label}
              {hasVerificationTask ? <ArrowUpRightIcon /> : null}
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
              configuration.
              {hasVerificationTask
                ? ' Click to see the verification task.'
                : ''}
            </div>
          }
        >
          {wrapBadge(
            <Badge variant="warning" className={badgeClassName}>
              <Icon
                className={['size-3', iconClassName].filter(Boolean).join(' ')}
              />
              {label}
              {hasVerificationTask ? <ArrowUpRightIcon /> : null}
            </Badge>,
          )}
        </BasicTooltip>
      );
  }
}
