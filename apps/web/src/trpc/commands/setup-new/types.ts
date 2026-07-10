export type QueuedOnboardingTask = {
  id: string;
  suggestionId: string | null;
  title: string;
  prompt: string | null;
  sortOrder: number;
  launchedTaskId: string | null;
  launchedAt: Date | string | null;
  environmentId: string | null;
};
