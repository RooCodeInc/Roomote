import { PRODUCT_NAME } from '@roomote/types';
import { users, alias } from '@roomote/db/server';
import { type AnalyticsDetailsRow, type AnalyticsDimension } from '@/types';
import { TASK_SOURCE_ORDER } from '@/lib/task-surface-label';

export const SYSTEM_SOURCE = 'System';
export const UNKNOWN_REPO_LABEL = 'Unknown Repo';
export const NO_PROJECT_LABEL = 'No Environment';
export const NO_VALUE_LABEL = '—';
export const ALL_REPOS_LABEL = 'All Repos';
export const WEEK_OPTIONS = { weekStartsOn: 1 as const };
export const ROOMOTE_CREATED_BY_LABEL = PRODUCT_NAME;
export const HUMAN_CREATED_BY_LABEL = 'Human';
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = 365;

export const SOURCE_ORDER = TASK_SOURCE_ORDER;
export const PR_STATUS_ORDER = ['Closed', 'Draft', 'Open', 'Merged'] as const;

export type AnalyticsDimensionValue = {
  key: string;
  label: string;
  disambiguationLabel?: string;
};

export const usageUsers = alias(users, 'analytics_usage_users');
export const taskInitiatorUsers = alias(
  users,
  'analytics_task_initiator_users',
);

export type AnalyticsRow = {
  id: string;
  timestamp: Date;
  value: number;
  dimensions: Partial<Record<AnalyticsDimension, AnalyticsDimensionValue>>;
  details: AnalyticsDetailsRow;
  meta?: {
    authorLogin?: string | null;
    canonicalTaskId?: string | null;
    isMerged?: boolean;
    isRoomote?: boolean;
    prKeys?: string[];
  };
};

export type PullRequestAnalyticsRow = AnalyticsRow & {
  meta: {
    authorLogin: string | null;
    canonicalTaskId: string | null;
    isMerged: boolean;
    isRoomote: boolean;
  };
};
