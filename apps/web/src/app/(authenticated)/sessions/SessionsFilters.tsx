'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { getSessionStatusLabel, SESSION_STATUSES } from '@roomote/types';

import type { TimePeriodFilter } from '@/types';
import { SESSION_SURFACES } from '@/components/sessions/session-surfaces';
import { TaskFilters } from '@/components/tasks';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

export function SessionsFilters({
  userId,
  timePeriod,
  scope = 'all',
  status = 'all',
  view = 'list',
  query = '',
  repository = null,
  pullRequest = null,
  model = null,
  source = 'all',
}: {
  userId: string | null;
  timePeriod: TimePeriodFilter;
  scope?: string;
  status?: string;
  view?: string;
  query?: string;
  repository?: string | null;
  pullRequest?: string | null;
  model?: string | null;
  source?: string;
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
    <div className="flex w-full flex-wrap items-center gap-2">
      <Select
        value={scope}
        onValueChange={(value) =>
          updateParams((params) => params.set('scope', value))
        }
      >
        <SelectTrigger size="sm" aria-label="Session scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sessions</SelectItem>
          <SelectItem value="tasks">Tasks</SelectItem>
          <SelectItem value="reviews">Reviews</SelectItem>
          <SelectItem value="automations">Automations</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={source}
        onValueChange={(value) =>
          updateParams((params) => {
            if (value === 'all') params.delete('source');
            else params.set('source', value);
          })
        }
      >
        <SelectTrigger size="sm" aria-label="Session source">
          <SelectValue placeholder="All sources" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sources</SelectItem>
          {Object.entries(SESSION_SURFACES).map(([value, descriptor]) => (
            <SelectItem key={value} value={value}>
              {descriptor.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={status}
        onValueChange={(value) =>
          updateParams((params) => {
            if (value === 'all') params.delete('status');
            else params.set('status', value);
          })
        }
      >
        <SelectTrigger size="sm" aria-label="Session status">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {SESSION_STATUSES.map((value) => (
            <SelectItem key={value} value={value} className="capitalize">
              {getSessionStatusLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <form
        className="flex min-w-52 flex-1 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          updateParams((params) => {
            const value = String(form.get('q') ?? '').trim();
            if (value) params.set('q', value);
            else params.delete('q');
          });
        }}
      >
        <Input
          name="q"
          defaultValue={query}
          aria-label="Search sessions"
          placeholder="Search sessions"
          className="h-8"
        />
        <Button type="submit" size="sm" variant="outline">
          Search
        </Button>
      </form>
      <Select
        value={view}
        onValueChange={(value) =>
          updateParams((params) => params.set('view', value))
        }
      >
        <SelectTrigger size="sm" aria-label="Session view">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="list">List</SelectItem>
          <SelectItem value="board">Board</SelectItem>
        </SelectContent>
      </Select>
      <TaskFilters
        userId={userId ?? 'all'}
        repositoryName={repository}
        pullRequest={pullRequest}
        model={model}
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
        onRepositoryChange={(value) =>
          updateParams((params) => {
            if (value) params.set('repository', value);
            else params.delete('repository');
          })
        }
        onPullRequestChange={(value) =>
          updateParams((params) => {
            if (value) params.set('pullRequest', value);
            else params.delete('pullRequest');
          })
        }
        onModelChange={(value) =>
          updateParams((params) => {
            if (value) params.set('model', value);
            else params.delete('model');
          })
        }
        onTimePeriodChange={(period) =>
          updateParams((params) => {
            if (period === 'all') {
              params.delete('period');
            } else {
              params.set('period', String(period));
            }
          })
        }
        showRepository
        showPullRequest
        showModel
        showTaskType={false}
      />
    </div>
  );
}
