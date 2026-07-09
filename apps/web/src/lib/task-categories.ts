import { type TaskWorkflow, TASK_WORKFLOWS } from '@roomote/types';

import {
  type LucideIcon,
  GitPullRequest,
  FileText,
  Bug,
} from '@/components/system';

type TaskCategory = {
  id: string;
  label: string;
  workflows: TaskWorkflow[];
  icon: LucideIcon;
  isAutonomous: boolean;
};

const TASK_CATEGORIES: readonly TaskCategory[] = [
  {
    id: 'delegated',
    label: 'Delegated Tasks',
    workflows: ['standard'],
    icon: FileText,
    isAutonomous: false,
  },
  {
    id: 'pr-reviews',
    label: 'PR Reviews',
    workflows: ['pr_review'],
    icon: GitPullRequest,
    isAutonomous: true,
  },
  {
    id: 'auto-fixes',
    label: 'Auto-fixes',
    workflows: ['pr_conflict_resolve'],
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

/**
 * Workflows whose tasks are hidden from default task lists. Kept in sync with
 * the launch paths that stamp `tasks.visibility = 'hidden'`; the explicit
 * workflow filter is the only UI surface that can reveal them.
 */
export const HIDDEN_TASK_WORKFLOWS: ReadonlySet<TaskWorkflow> = new Set([
  'scan',
  'mcp_recommendations',
  'env_snapshot',
]);

export const DEFAULT_VISIBLE_TASK_WORKFLOWS: readonly TaskWorkflow[] =
  TASK_WORKFLOWS.filter((workflow) => !HIDDEN_TASK_WORKFLOWS.has(workflow));

export function isTaskWorkflow(value: string): value is TaskWorkflow {
  return (TASK_WORKFLOWS as readonly string[]).includes(value);
}
