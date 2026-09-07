import type { TaskSurface } from '@roomote/types';

import { getTaskSurfaceLabel } from '@/lib/task-surface-label';

/**
 * One registry for every surface a Session can originate from (the
 * sessions_source_surface_check constraint's value set). Labels come from the
 * canonical getTaskSurfaceLabel map so the filter, cards, and analytics can
 * never disagree; this module adds the session-only entries and brand icons.
 */

type SessionSurfaceBrandIcon =
  | 'linear'
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'bitbucket'
  | 'ado'
  | 'discord'
  | 'teams'
  | 'telegram';

type SurfaceDescriptor = {
  label: string;
  brandIcon?: SessionSurfaceBrandIcon;
};

const surface = (
  value: TaskSurface,
  brandIcon?: SessionSurfaceBrandIcon,
): SurfaceDescriptor => ({
  label: getTaskSurfaceLabel(value) ?? value,
  brandIcon,
});

const SESSION_SURFACES: Record<string, SurfaceDescriptor> = {
  web: surface('web'),
  api: surface('api'),
  slack: surface('slack'),
  teams: surface('teams', 'teams'),
  telegram: surface('telegram', 'telegram'),
  discord: surface('discord', 'discord'),
  linear: surface('linear', 'linear'),
  github: surface('github', 'github'),
  gitlab: surface('gitlab', 'gitlab'),
  gitea: surface('gitea', 'gitea'),
  ado: surface('ado', 'ado'),
  bitbucket: surface('bitbucket', 'bitbucket'),
  system: { label: 'System' },
  automation: { label: 'Automation' },
};

export function getSessionSurfaceLabel(surface: string): string {
  return SESSION_SURFACES[surface]?.label ?? surface;
}

export function getSessionSurfaceBrandIcon(
  surface: string,
): SessionSurfaceBrandIcon | undefined {
  return SESSION_SURFACES[surface]?.brandIcon;
}
