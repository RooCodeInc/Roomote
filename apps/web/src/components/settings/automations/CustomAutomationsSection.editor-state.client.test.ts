import {
  createInitialCustomAutomationEditorState,
  customAutomationEditorReducer,
} from './CustomAutomationsSection';

describe('custom automation editor transitions', () => {
  it.each([
    { type: 'close' as const },
    { type: 'create-succeeded' as const },
    { type: 'update-succeeded' as const },
  ])('$type clears every transient editor value', (action) => {
    const initial = createInitialCustomAutomationEditorState();
    const dirty = {
      ...initial,
      editingId: 'automation-1',
      isCreating: true,
      form: { ...initial.form, name: 'Stale automation' },
      editingField: 'webhook' as const,
      modelPickerOpen: true,
      webhookEnabled: true,
      webhookUrl: 'https://example.test/webhook',
      fieldErrors: { name: 'Stale validation' },
      resolvedCron: '0 9 * * 1-5',
      scheduleSummary: 'Weekdays at 9 AM',
    };

    expect(customAutomationEditorReducer(dirty, action)).toEqual(initial);
  });

  it('opens a new editor with a clean transition state and supplied defaults', () => {
    const initial = createInitialCustomAutomationEditorState();
    const dirty = {
      ...initial,
      editingId: 'automation-1',
      editingField: 'schedule' as const,
      modelPickerOpen: true,
      webhookEnabled: true,
      webhookUrl: 'https://example.test/webhook',
      fieldErrors: { schedule: 'Stale validation' },
      resolvedCron: '0 9 * * 1-5',
      scheduleSummary: 'Weekdays at 9 AM',
    };
    const form = {
      ...initial.form,
      targetProvider: 'none' as const,
      targetChannelId: '',
    };

    expect(
      customAutomationEditorReducer(dirty, { type: 'open-create', form }),
    ).toEqual({
      ...initial,
      isCreating: true,
      form,
    });
  });

  it('uses the same clean edit transition for direct and hash-open callers', () => {
    const initial = createInitialCustomAutomationEditorState();
    const dirty = {
      ...initial,
      isCreating: true,
      editingField: 'destination' as const,
      modelPickerOpen: true,
      webhookEnabled: true,
      webhookUrl: 'https://example.test/webhook',
      fieldErrors: { environment: 'Stale validation' },
      resolvedCron: '0 9 * * 1-5',
      scheduleSummary: 'Weekdays at 9 AM',
    };
    const form = { ...initial.form, name: 'Existing automation' };
    const action = {
      type: 'open-edit' as const,
      editingId: 'automation-2',
      form,
      resolvedCron: null,
    };

    expect(customAutomationEditorReducer(dirty, action)).toEqual({
      ...initial,
      editingId: 'automation-2',
      form,
    });
  });
});
