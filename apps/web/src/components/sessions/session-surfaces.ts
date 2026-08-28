/**
 * One registry for every surface a Session can originate from (the
 * sessions_source_surface_check constraint's value set). The filter options,
 * labels, and brand icons all derive from here so a new surface shows up
 * everywhere at once.
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

export const SESSION_SURFACES: Record<string, SurfaceDescriptor> = {
  web: { label: 'Web' },
  api: { label: 'API' },
  slack: { label: 'Slack' },
  teams: { label: 'Teams', brandIcon: 'teams' },
  telegram: { label: 'Telegram', brandIcon: 'telegram' },
  discord: { label: 'Discord', brandIcon: 'discord' },
  linear: { label: 'Linear', brandIcon: 'linear' },
  github: { label: 'GitHub', brandIcon: 'github' },
  gitlab: { label: 'GitLab', brandIcon: 'gitlab' },
  gitea: { label: 'Gitea', brandIcon: 'gitea' },
  ado: { label: 'Azure DevOps', brandIcon: 'ado' },
  bitbucket: { label: 'Bitbucket', brandIcon: 'bitbucket' },
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
