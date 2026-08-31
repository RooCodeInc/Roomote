import {
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  ROOMOTE_SESSION_DEFAULT_ACTIONS,
  resolveRoomoteCommunicationTarget,
  roomoteManagementFieldSchemas,
  shouldSearchTasks,
} from './manage-tasks-tool';

describe('Roomote MCP management contract', () => {
  it('puts session actions before compatibility task actions', () => {
    expect(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS.slice(0, 5)).toEqual(
      ROOMOTE_SESSION_DEFAULT_ACTIONS,
    );
    expect(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS).toContain('launch');
    expect(ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION).toContain(
      'Use start to begin new work in a Session',
    );
    expect(ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION).toContain(
      'direct task operations retained for compatibility',
    );
  });

  it('shares canonical session fields across MCP surfaces', () => {
    expect(
      roomoteManagementFieldSchemas.sessionId.safeParse(crypto.randomUUID())
        .success,
    ).toBe(true);
    expect(
      roomoteManagementFieldSchemas.sessionId.safeParse('task-123').success,
    ).toBe(false);
    expect(
      roomoteManagementFieldSchemas.status.safeParse('needs_input').success,
    ).toBe(true);
    expect(roomoteManagementFieldSchemas.taskId.description).toContain(
      'Optional concrete task ID',
    );
    expect(roomoteManagementFieldSchemas.sessionId.description).toContain(
      'when taskId is omitted',
    );
  });

  it('defaults communication to Sessions and lets taskId override naturally', () => {
    expect(
      resolveRoomoteCommunicationTarget({ sessionId: crypto.randomUUID() }),
    ).toMatchObject({ kind: 'session' });
    expect(
      resolveRoomoteCommunicationTarget({
        sessionId: crypto.randomUUID(),
        taskId: 'task-123',
      }),
    ).toEqual({ kind: 'task', id: 'task-123' });
    expect(resolveRoomoteCommunicationTarget({})).toBeNull();
  });

  it('defaults search to Sessions while preserving concrete task-search calls', () => {
    expect(shouldSearchTasks({ action: 'search' })).toBe(false);
    expect(shouldSearchTasks({ action: 'search_tasks' })).toBe(true);
    expect(
      shouldSearchTasks({ action: 'search', pullRequest: 'owner/repo#1' }),
    ).toBe(true);
    expect(shouldSearchTasks({ action: 'search', status: 'completed' })).toBe(
      true,
    );
    expect(shouldSearchTasks({ action: 'search', status: 'all' })).toBe(true);
  });
});
