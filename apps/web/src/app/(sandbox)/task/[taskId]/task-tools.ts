import type { LucideIcon } from 'lucide-react';

import {
  getTaskToolActionIdFromInvocation,
  type TaskToolActionId,
} from '@roomote/types';

import {
  GitCommitVertical,
  GitPullRequestCreateArrow,
  GitPullRequestDraft,
  Image,
  ListChecks as ListCheck,
  ScanFace,
  ScanSearch,
  Sparkles,
} from '@/components/system';

interface TaskToolDefinition {
  actionId: TaskToolActionId;
  label: string;
  icon: LucideIcon;
  separator: boolean;
}

const TASK_TOOL_ACTIONS = {
  simplify: {
    actionId: 'simplify',
    label: 'Simplify changed code',
    icon: Sparkles,
    separator: false,
  },
  push: {
    actionId: 'push',
    label: 'Commit + push',
    icon: GitCommitVertical,
    separator: true,
  },
  'create-draft-pr': {
    actionId: 'create-draft-pr',
    label: 'Push to a draft PR',
    icon: GitPullRequestDraft,
    separator: false,
  },
  'create-pr': {
    actionId: 'create-pr',
    label: 'Push to a ready PR',
    icon: GitPullRequestCreateArrow,
    separator: false,
  },
  'review-code': {
    actionId: 'review-code',
    label: 'Review code',
    icon: ScanSearch,
    separator: true,
  },
  'review-and-fix': {
    actionId: 'review-and-fix',
    label: 'Review code and fix issues',
    icon: ScanFace,
    separator: false,
  },
  'address-pr-feedback': {
    actionId: 'address-pr-feedback',
    label: 'Address PR feedback',
    icon: ListCheck,
    separator: false,
  },
  'capture-visual-proof': {
    actionId: 'capture-visual-proof',
    label: 'Capture visual proof',
    icon: Image,
    separator: true,
  },
} as const satisfies Record<string, TaskToolDefinition>;

type TaskToolMeta = (typeof TASK_TOOL_ACTIONS)[TaskToolActionId];

export const TASK_TOOL_CATALOG = [
  TASK_TOOL_ACTIONS.simplify,
  TASK_TOOL_ACTIONS.push,
  TASK_TOOL_ACTIONS['create-draft-pr'],
  TASK_TOOL_ACTIONS['create-pr'],
  TASK_TOOL_ACTIONS['review-code'],
  TASK_TOOL_ACTIONS['review-and-fix'],
  TASK_TOOL_ACTIONS['address-pr-feedback'],
  TASK_TOOL_ACTIONS['capture-visual-proof'],
] as const satisfies readonly TaskToolMeta[];

/**
 * Returns the Task Tool metadata for an exact packaged-skill invocation,
 * regardless of whether the harness delimiter is `/` or `$`.
 */
export function getTaskToolByInvocation(
  text: string,
): TaskToolMeta | undefined {
  const actionId = getTaskToolActionIdFromInvocation(text);

  if (!actionId) {
    return undefined;
  }

  return TASK_TOOL_ACTIONS[actionId];
}
