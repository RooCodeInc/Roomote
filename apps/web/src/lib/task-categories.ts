import { CloudTaskType } from '@roomote/types';

import {
  type LucideIcon,
  GitPullRequest,
  FileText,
  Bug,
} from '@/components/system';

type TaskCategory = {
  id: string;
  label: string;
  taskTypes: CloudTaskType[];
  icon: LucideIcon;
  isAutonomous: boolean;
};

const TASK_CATEGORIES: readonly TaskCategory[] = [
  {
    id: 'delegated',
    label: 'Delegated Tasks',
    taskTypes: [
      CloudTaskType.StandardTask,
      CloudTaskType.SlackAppMention,
      CloudTaskType.LinearAgentSession,
    ],
    icon: FileText,
    isAutonomous: false,
  },
  {
    id: 'pr-reviews',
    label: 'PR Reviews',
    taskTypes: [
      CloudTaskType.GithubPrReview,
      CloudTaskType.GithubPrReviewSync,
      CloudTaskType.GithubPrReviewFollowUp,
    ],
    icon: GitPullRequest,
    isAutonomous: true,
  },
  {
    id: 'auto-fixes',
    label: 'Auto-fixes',
    taskTypes: [CloudTaskType.GithubPrConflictResolve],
    icon: Bug,
    isAutonomous: true,
  },
] as const;

export function getTaskCategoryById(id: string | null | undefined) {
  if (!id) {
    return null;
  }

  return TASK_CATEGORIES.find((category) => category.id === id) ?? null;
}
