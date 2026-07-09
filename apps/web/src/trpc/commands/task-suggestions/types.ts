import type {
  CloudTaskPayload,
  SuggestionCategory,
  SuggestionPriority,
  TaskPayloadKind,
  TaskSuggestionSource,
  WorkItemStatus,
} from '@roomote/types';

export type PersistedTaskSuggestion = {
  id: string;
  title: string;
  brief: string;
  repositoryIds: string[];
  sortOrder: number;
  dismissedAt: Date | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  readinessMessage: string | null;
};

export type TaskSuggestionGenerationStatus =
  | 'idle'
  | 'pending'
  | 'ready'
  | 'empty';

export type SuggestionHistoryAutomation = TaskSuggestionSource | 'onboarding';

// Suggestions are now work_items(kind='suggestion'); the old 'started' status
// maps to the merged model's 'launched'.
export type VisibleTaskSuggestionStatus = Extract<
  WorkItemStatus,
  'open' | 'launched' | 'dismissed'
>;

export type SuggestionHistoryStatusFilter =
  | 'proposed'
  | 'accepted'
  | 'ignored'
  | 'all';

export type SuggestionHistoryItem = {
  id: string;
  title: string;
  brief: string;
  status: VisibleTaskSuggestionStatus;
  createdAt: Date;
  automation: SuggestionHistoryAutomation;
  automationLabel: string;
  repositoryLabel: string;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  investigationContext: string | null;
  readinessMessage: string | null;
};

export type SuggestionSourceCloudJob = {
  payloadKind: TaskPayloadKind;
  payload: CloudTaskPayload;
};
