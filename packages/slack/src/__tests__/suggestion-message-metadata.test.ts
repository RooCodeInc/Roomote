import {
  buildTaskSuggestionMessageMetadata,
  TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE,
} from '../suggestion-message-metadata';

describe('task suggestion message metadata', () => {
  it.each(['task-1', null])(
    'builds the reaction fallback payload with source task %s',
    (sourceTaskId) => {
      expect(
        buildTaskSuggestionMessageMetadata({
          sourceTaskId,
          suggestionId: 'suggestion-1',
        }),
      ).toEqual({
        event_type: TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE,
        event_payload: {
          sourceTaskId,
          suggestionId: 'suggestion-1',
          schemaVersion: 1,
        },
      });
    },
  );
});
