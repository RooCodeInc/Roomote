import type { ComponentType } from 'react';

import type { AnalyticsDimension } from '@/types';
import {
  CircleUserRound,
  FolderIcon,
  GitPullRequest,
  RadioTower,
  VectorSquare,
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
};
