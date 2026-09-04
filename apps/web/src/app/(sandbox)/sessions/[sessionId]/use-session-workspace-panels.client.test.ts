import {
  createSessionWorkspacePanelState,
  getOrderedSessionTaskPanelIds,
  getSessionTaskPanelCapacity,
  getVisibleSessionTaskPanelIds,
  sessionWorkspacePanelReducer,
  type SessionWorkspacePanelAction,
  type SessionWorkspacePanelState,
} from './use-session-workspace-panels';

function reduce(
  state: SessionWorkspacePanelState,
  ...actions: SessionWorkspacePanelAction[]
) {
  return actions.reduce(sessionWorkspacePanelReducer, state);
}

describe('sessionWorkspacePanelReducer', () => {
  it('represents artifact utility state without a parallel selection', () => {
    const deepLinked = createSessionWorkspacePanelState({
      hasRequestedArtifact: true,
    });
    expect(deepLinked.utilityPanel).toEqual({
      kind: 'artifacts',
      artifact: null,
    });

    const selection = {
      owner: { sessionId: 'session-1' },
      path: 'notes/decision.md',
      version: 2,
    } as const;
    const viewing = sessionWorkspacePanelReducer(deepLinked, {
      type: 'open-session-artifact',
      artifact: selection,
    });
    expect(viewing.utilityPanel).toEqual({
      kind: 'artifacts',
      artifact: selection,
    });
    expect(
      sessionWorkspacePanelReducer(viewing, {
        type: 'back-to-session-artifacts',
      }).utilityPanel,
    ).toEqual({ kind: 'artifacts', artifact: null });
  });

  it.each([
    {
      name: 'opens a task in the rightmost visible slot',
      initialTaskPanelIds: ['task-1', 'task-2', 'task-3'],
      action: {
        type: 'open-task',
        taskId: 'task-4',
        selectedTaskId: null,
        capacity: 3,
      } satisfies SessionWorkspacePanelAction,
      expectedTaskPanelIds: ['task-1', 'task-2', 'task-4', 'task-3'],
    },
    {
      name: 'moves an existing task to the rightmost visible slot',
      initialTaskPanelIds: ['task-1', 'task-2', 'task-3'],
      action: {
        type: 'open-task',
        taskId: 'task-1',
        selectedTaskId: null,
        capacity: 2,
      } satisfies SessionWorkspacePanelAction,
      expectedTaskPanelIds: ['task-2', 'task-1', 'task-3'],
    },
    {
      name: 'leaves local slots unchanged when a selected task must be replaced',
      initialTaskPanelIds: ['task-2'],
      action: {
        type: 'open-task',
        taskId: 'task-3',
        selectedTaskId: 'task-1',
        capacity: 1,
      } satisfies SessionWorkspacePanelAction,
      expectedTaskPanelIds: ['task-2'],
    },
  ])('$name', ({ initialTaskPanelIds, action, expectedTaskPanelIds }) => {
    const state = {
      ...createSessionWorkspacePanelState(),
      utilityPanel: { kind: 'info' } as const,
      taskPanelIds: initialTaskPanelIds,
      taskArtifacts: { [action.taskId]: { path: 'stale.txt' } },
    };

    expect(sessionWorkspacePanelReducer(state, action)).toMatchObject({
      utilityPanel: null,
      taskPanelIds: expectedTaskPanelIds,
      taskArtifacts: {},
      promptFocusTaskId: action.taskId,
    });
  });

  it('seeds wide panels once without duplicating the URL-selected task', () => {
    const state = {
      ...createSessionWorkspacePanelState(),
      taskPanelIds: ['task-2'],
    };
    const seeded = sessionWorkspacePanelReducer(state, {
      type: 'seed-wide-panels',
      taskIds: ['task-1', 'task-2', 'task-3'],
      selectedTaskId: 'task-1',
    });

    expect(seeded.taskPanelIds).toEqual(['task-2', 'task-3']);
    expect(seeded.promptFocusTaskId).toBe('task-1');
    expect(getOrderedSessionTaskPanelIds(seeded, 'task-1')).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
  });

  it('changes panel visibility on resize without discarding hidden slots', () => {
    const state = {
      ...createSessionWorkspacePanelState(),
      taskPanelIds: ['task-2', 'task-3', 'task-4'],
    };

    expect(getVisibleSessionTaskPanelIds(state, 'task-1', 2)).toEqual([
      'task-1',
      'task-2',
    ]);
    expect(getVisibleSessionTaskPanelIds(state, 'task-1', 4)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
    ]);
    expect(state.taskPanelIds).toEqual(['task-2', 'task-3', 'task-4']);
  });

  it.each([
    {
      utilityPanel: null,
      expectedUtilityPanel: null,
      expectedFocus: 'task-3',
    },
    {
      utilityPanel: { kind: 'tasks' } as const,
      expectedUtilityPanel: null,
      expectedFocus: 'task-3',
    },
    {
      utilityPanel: { kind: 'info' } as const,
      expectedUtilityPanel: { kind: 'info' },
      expectedFocus: null,
    },
  ])(
    'inserts new tasks while preserving $utilityPanel utility intent',
    ({ utilityPanel, expectedUtilityPanel, expectedFocus }) => {
      const state = {
        ...createSessionWorkspacePanelState(),
        utilityPanel,
        taskPanelIds: ['task-1', 'task-2'],
      };
      const next = sessionWorkspacePanelReducer(state, {
        type: 'add-tasks',
        taskIds: ['task-3', 'task-4'],
        selectedTaskId: null,
        capacity: 2,
      });

      expect(next.taskPanelIds).toEqual([
        'task-1',
        'task-3',
        'task-4',
        'task-2',
      ]);
      expect(next.utilityPanel).toEqual(expectedUtilityPanel);
      expect(next.promptFocusTaskId).toBe(expectedFocus);
    },
  );

  it('opens all tasks side by side and clears task artifact overlays', () => {
    const state = {
      ...createSessionWorkspacePanelState(),
      utilityPanel: { kind: 'tasks' } as const,
      taskArtifacts: {
        'task-1': { path: 'one.txt' },
        'task-2': { path: 'two.txt' },
      },
    };

    expect(
      sessionWorkspacePanelReducer(state, {
        type: 'open-tasks-side-by-side',
        taskIds: ['task-1', 'task-2', 'task-3'],
        selectedTaskId: 'task-2',
      }),
    ).toEqual({
      utilityPanel: null,
      taskPanelIds: ['task-1', 'task-3'],
      taskArtifacts: {},
      promptFocusTaskId: 'task-2',
    });
  });

  it('preserves task slots while utility panels toggle', () => {
    const state = {
      ...createSessionWorkspacePanelState(),
      taskPanelIds: ['task-1', 'task-2'],
    };
    const opened = sessionWorkspacePanelReducer(state, {
      type: 'toggle-utility',
      kind: 'artifacts',
    });
    const switched = sessionWorkspacePanelReducer(opened, {
      type: 'toggle-utility',
      kind: 'previews',
    });
    const closed = sessionWorkspacePanelReducer(switched, {
      type: 'toggle-utility',
      kind: 'previews',
    });

    expect(opened.utilityPanel).toEqual({ kind: 'artifacts', artifact: null });
    expect(switched.utilityPanel).toEqual({ kind: 'previews' });
    expect(closed).toMatchObject({
      utilityPanel: null,
      taskPanelIds: ['task-1', 'task-2'],
    });
  });

  it.each([
    {
      name: 'selected task to local task',
      currentTaskId: 'task-1',
      nextTaskId: 'task-2',
      selectedTaskId: 'task-1',
      expected: ['task-1', 'task-3'],
    },
    {
      name: 'local task to selected task',
      currentTaskId: 'task-2',
      nextTaskId: 'task-1',
      selectedTaskId: 'task-1',
      expected: ['task-1', 'task-3'],
    },
    {
      name: 'local task to local task',
      currentTaskId: 'task-2',
      nextTaskId: 'task-3',
      selectedTaskId: 'task-1',
      expected: ['task-3', 'task-2'],
    },
  ])(
    'swaps $name and clears both artifact overlays',
    ({ currentTaskId, nextTaskId, selectedTaskId, expected }) => {
      const state = {
        ...createSessionWorkspacePanelState(),
        taskPanelIds: ['task-2', 'task-3'],
        taskArtifacts: {
          [currentTaskId]: { path: 'current.txt' },
          [nextTaskId]: { path: 'next.txt' },
        },
      };
      const next = sessionWorkspacePanelReducer(state, {
        type: 'select-panel-task',
        currentTaskId,
        nextTaskId,
        selectedTaskId,
      });

      expect(next.taskPanelIds).toEqual(expected);
      expect(next.taskArtifacts).toEqual({});
    },
  );

  it('keeps task artifact selection with its task until back or close', () => {
    const initial = {
      ...createSessionWorkspacePanelState(),
      taskPanelIds: ['task-1'],
    };
    const viewing = sessionWorkspacePanelReducer(initial, {
      type: 'open-task-artifact',
      taskId: 'task-1',
      artifact: { path: 'proof.png', version: 3 },
    });
    expect(viewing.taskArtifacts).toEqual({
      'task-1': { path: 'proof.png', version: 3 },
    });
    expect(
      sessionWorkspacePanelReducer(viewing, {
        type: 'back-to-task',
        taskId: 'task-1',
      }).taskArtifacts,
    ).toEqual({});
    expect(
      sessionWorkspacePanelReducer(viewing, {
        type: 'close-task',
        taskId: 'task-1',
        selectedTaskId: null,
      }),
    ).toMatchObject({ taskPanelIds: [], taskArtifacts: {} });
  });

  it('clears every panel selection when returning to the main transcript', () => {
    const state = {
      ...reduce(
        createSessionWorkspacePanelState(),
        { type: 'toggle-utility', kind: 'info' },
        {
          type: 'open-task-artifact',
          taskId: 'task-1',
          artifact: { path: 'proof.png' },
        },
      ),
      taskPanelIds: ['task-1'],
      promptFocusTaskId: 'task-1',
    };

    expect(sessionWorkspacePanelReducer(state, { type: 'show-main' })).toEqual(
      createSessionWorkspacePanelState(),
    );
  });
});

describe('getSessionTaskPanelCapacity', () => {
  it.each([
    { width: 0, isMdOrLarger: true, expected: 1 },
    { width: 700, isMdOrLarger: false, expected: 1 },
    { width: 1024, isMdOrLarger: true, expected: 1 },
    { width: 1280, isMdOrLarger: true, expected: 2 },
    { width: 1920, isMdOrLarger: true, expected: 3 },
    { width: 2560, isMdOrLarger: true, expected: 5 },
    { width: 3840, isMdOrLarger: true, expected: 8 },
  ])(
    'returns $expected task panels for a $width px workspace',
    ({ width, isMdOrLarger, expected }) => {
      expect(getSessionTaskPanelCapacity(width, isMdOrLarger)).toBe(expected);
    },
  );
});
