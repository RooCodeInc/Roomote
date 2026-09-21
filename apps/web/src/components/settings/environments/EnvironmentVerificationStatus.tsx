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
  | 'ready'
  | 'verifying'
  | 'configuring'
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
  ready: {
    Icon: Check,
    label: 'Ready',
  },
  verifying: {
    Icon: Loader2,
    label: 'Verifying',
    iconClassName: 'animate-spin',
  },
  configuring: {
    Icon: Loader2,
    label: 'Configuring',
    iconClassName: 'animate-spin',
  },
  failed: {
    Icon: X,
    label: 'Failed',
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
  > & { config?: unknown },
): EnvironmentVerificationState {
  if (environment.isVerified) {
    return 'ready';
  }

  if (environment.verificationError) {
    return 'failed';
  }

  const recipe = (
    environment.config as EnvironmentWithMeta['config'] | undefined
  )?.environment_recipe;

  // An unresolved recipe with an active verification task is still resolving
  // package versions; ordinary environments without a task are Configured.
  if (
    recipe &&
    !recipe.resolution &&
    environment.verificationTaskId &&
    environment.verificationTaskActive
  ) {
    return 'configuring';
  }

  // Only show "verifying" while the verification task actually has an active
  // run. A stale task id from a crashed or unreported attempt falls back to
  // "configured" instead of appearing stuck forever.
  if (environment.verificationTaskId && environment.verificationTaskActive) {
    return 'verifying';
  }

  return 'configured';
}

export function EnvironmentVerificationBadge({
  env,
}: {
  env: EnvironmentWithMeta;
}) {
  const state = getEnvironmentVerificationState(env);
  const recipe = env.config?.environment_recipe;
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
    case 'ready':
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
    case 'configuring':
    case 'verifying':
      return (
        <BasicTooltip
          content={
            <div className="text-sm">
              {state === 'configuring'
                ? 'Roomote is resolving this environment recipe from official repositories. It becomes available after verification succeeds.'
                : recipe
                  ? 'Roomote is checking that this recipe environment works. It becomes available after verification succeeds.'
                  : 'Roomote is checking that this environment works. You can keep using it while verification finishes.'}
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
