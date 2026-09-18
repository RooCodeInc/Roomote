/**
 * `list_repositories` exists twice with one contract: as a native Fast tool
 * over every active repository, and as a task-sandbox tool over the
 * repositories the run is authorized to check out.
 */
export const LIST_REPOSITORIES_TOOL_NAME = 'list_repositories';
export const LIST_REPOSITORIES_DEFAULT_LIMIT = 50;
export const LIST_REPOSITORIES_MAX_LIMIT = 100;
