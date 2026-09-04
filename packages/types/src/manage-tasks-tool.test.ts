import {
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  ROOMOTE_SESSION_DEFAULT_ACTIONS,
  getRoomoteSearchStatusError,
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
    expect(roomoteManagementFieldSchemas.sessionId.description).toContain(
      'responses return the canonical Session ID',
    );
  });

  it('defaults communication to Sessions and lets taskId override naturally', () => {
    expect(
      resolveRoomoteCommunicationTarget({ sessionId: crypto.randomUUID() }),
    ).toMatchObject({ kind: 'session' });
    expect(
      resolveRoomoteCommunicationTarget({
        sessionId: crypto.randomUUID(),
        taskId: '0abc123def456',
      }),
    ).toEqual({ kind: 'task', id: '0abc123def456' });
    expect(
      resolveRoomoteCommunicationTarget({
        sessionId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect(resolveRoomoteCommunicationTarget({})).toBeNull();
    expect(
      roomoteManagementFieldSchemas.taskId.safeParse(crypto.randomUUID())
        .success,
    ).toBe(false);
    expect(
      roomoteManagementFieldSchemas.taskId.safeParse('0abc123def456').success,
    ).toBe(true);
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
    expect(
      getRoomoteSearchStatusError({
        action: 'search_tasks',
        status: 'needs_input',
      }),
    ).toBe(
      'status must be one of: active, completed, all when search resolves to tasks',
    );
    expect(
      getRoomoteSearchStatusError({
        action: 'search_tasks',
        status: 'active',
      }),
    ).toBeNull();
    expect(
      getRoomoteSearchStatusError({
        action: 'search',
        pullRequest: 'owner/repo#1',
        status: 'needs_input',
      }),
    ).toBe(
      'status must be one of: active, completed, all when search resolves to tasks',
    );
  });
});
