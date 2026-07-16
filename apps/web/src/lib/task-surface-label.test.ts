import { getTaskSurfaceLabel, TASK_SOURCE_ORDER } from './task-surface-label';

describe('getTaskSurfaceLabel', () => {
  it('labels Discord task sources for analytics and history filters', () => {
    expect(getTaskSurfaceLabel('discord')).toBe('Discord');
    expect(TASK_SOURCE_ORDER).toContain('Discord');
  });

  it('leaves system and missing surfaces to each consumer fallback', () => {
    expect(getTaskSurfaceLabel('system')).toBeUndefined();
    expect(getTaskSurfaceLabel(null)).toBeUndefined();
  });
});
