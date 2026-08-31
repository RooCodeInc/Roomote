import {
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  ROOMOTE_SESSION_MANAGEMENT_ACTIONS,
  roomoteManagementFieldSchemas,
} from './manage-tasks-tool';

describe('Roomote MCP management contract', () => {
  it('puts session actions before compatibility task actions', () => {
    expect(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS.slice(0, 4)).toEqual(
      ROOMOTE_SESSION_MANAGEMENT_ACTIONS,
    );
    expect(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS).toContain('launch');
    expect(ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION).toContain(
      'Use start_session for new work',
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
      roomoteManagementFieldSchemas.sessionStatus.safeParse('needs_input')
        .success,
    ).toBe(true);
  });
});
