import type { TaskSurface } from '@roomote/types';

export const TASK_SOURCE_ORDER: readonly string[] = [
  'Slack',
  'Teams',
  'Telegram',
  'Discord',
  'GitHub',
  'GitLab',
  'Gitea',
  'Bitbucket Cloud',
  'Azure DevOps',
  'Linear',
  'Web',
  'API',
  'System',
];

/** Shared human-readable source label for analytics and task-history filters. */
export function getTaskSurfaceLabel(
  surface: TaskSurface | null | undefined,
): string | undefined {
  switch (surface) {
    case 'slack':
      return 'Slack';
    case 'teams':
      return 'Teams';
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'gitea':
      return 'Gitea';
    case 'bitbucket':
      return 'Bitbucket Cloud';
    case 'ado':
      return 'Azure DevOps';
    case 'linear':
      return 'Linear';
    case 'web':
      return 'Web';
    case 'api':
      return 'API';
    case 'system':
    default:
      return undefined;
  }
}
