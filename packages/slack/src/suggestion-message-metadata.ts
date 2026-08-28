import { TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE } from '@roomote/types';

export { TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE };

export function buildTaskSuggestionMessageMetadata(params: {
  sourceTaskId: string;
  suggestionId: string;
}) {
  return {
    event_type: TASK_SUGGESTION_MESSAGE_METADATA_EVENT_TYPE,
    event_payload: {
      sourceTaskId: params.sourceTaskId,
      suggestionId: params.suggestionId,
      schemaVersion: 1,
    },
  };
}
