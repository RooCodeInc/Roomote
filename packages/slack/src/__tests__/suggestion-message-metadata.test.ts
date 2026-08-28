import {
  buildTaskSuggestionMessageMetadata,
  TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE,
} from '../suggestion-message-metadata';

describe('task suggestion message metadata', () => {
  it('builds the reaction fallback payload', () => {
    expect(
      buildTaskSuggestionMessageMetadata({
        sourceTaskId: 'task-1',
        suggestionId: 'suggestion-1',
      }),
    ).toEqual({
      event_type: TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE,
      event_payload: {
        sourceTaskId: 'task-1',
        suggestionId: 'suggestion-1',
        schemaVersion: 1,
      },
    });
  });
});
