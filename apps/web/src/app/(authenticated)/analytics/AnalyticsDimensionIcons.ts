import type { ComponentType } from 'react';

import type { AnalyticsDimension } from '@/types';
import {
  Brain,
  CircleUserRound,
  Bot,
  Cpu,
  FolderIcon,
  GitPullRequest,
  RadioTower,
  VectorSquare,
  Rows4,
} from '@/components/system';

export const ANALYTICS_DIMENSION_ICONS: Record<
  AnalyticsDimension,
  ComponentType<{ className?: string }>
> = {
  user: CircleUserRound,
  project: VectorSquare,
  source: RadioTower,
  status: GitPullRequest,
  repo: FolderIcon,
  author: CircleUserRound,
  taskType: Bot,
  provider: Cpu,
  model: Brain,
  ownerKind: Bot,
  hasExecution: Rows4,
};
