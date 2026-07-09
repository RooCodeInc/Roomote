import {
  TaskPayloadKind,
  type AutomationWorkItemDisposition,
  type CloudTaskPayload,
  type SuggestionCategory,
  type SuggestionPriority,
  type WorkspaceReadiness,
} from '@roomote/types';

export type SuggestedTasksPayload = CloudTaskPayload<
  typeof TaskPayloadKind.Scan
>;

export type ResolvedRepository = {
  id: string;
  fullName: string;
};

export type PreparedAutomationWorkItem = {
  title: string;
  brief: string;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  actionKind: string;
  disposition: AutomationWorkItemDisposition;
  investigationContext: string | null;
  executionPrompt: string | null;
  fingerprint: string;
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: WorkspaceReadiness | null;
  readinessMessage: string | null;
};

export type PersistedAutomationWorkItem = {
  id: string;
  sourceTaskId?: string | null;
  title: string;
  brief: string;
  category: SuggestionCategory | null;
  priority: SuggestionPriority | null;
  actionKind: string;
  disposition: AutomationWorkItemDisposition;
  status: 'open' | 'acting' | 'started' | 'failed' | 'dismissed';
  investigationContext: string | null;
  executionPrompt: string | null;
  fingerprint: string;
  repositoryIds: string[];
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: WorkspaceReadiness | null;
  readinessMessage: string | null;
  sortOrder: number;
  executionTaskId: string | null;
  launchError: string | null;
};

export type PersistedDuplicateWorkItemRef = {
  id: string;
  fingerprint: string;
};

export type PersistedAutomationWorkItemsResult = {
  created: boolean;
  duplicateCount: number;
  duplicateWorkItemRefs: PersistedDuplicateWorkItemRef[];
  workItems: PersistedAutomationWorkItem[];
};
