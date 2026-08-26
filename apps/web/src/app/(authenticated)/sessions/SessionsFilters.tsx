'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import type { TimePeriodFilter } from '@/types';
import { TaskFilters } from '@/components/tasks';

export function SessionsFilters({
  userId,
  timePeriod,
}: {
  userId: string | null;
  timePeriod: TimePeriodFilter;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      // Filter changes restart pagination.
      params.delete('before');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <TaskFilters
      userId={userId ?? 'all'}
      repositoryName={null}
      pullRequest={null}
      model={null}
      timePeriod={timePeriod}
      onUserChange={(id) =>
        updateParams((params) => {
          if (id && id !== 'all') {
            params.set('user', id);
          } else {
            params.delete('user');
          }
        })
      }
      onRepositoryChange={() => {}}
      onPullRequestChange={() => {}}
      onModelChange={() => {}}
      onTimePeriodChange={(period) =>
        updateParams((params) => {
          if (period === 'all') {
            params.delete('period');
          } else {
            params.set('period', String(period));
          }
        })
      }
      showRepository={false}
      showPullRequest={false}
      showModel={false}
      showTaskType={false}
    />
  );
}
