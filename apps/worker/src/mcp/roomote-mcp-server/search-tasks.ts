import { searchTasks } from './tasks-api-client.js';
import { getHarnessLabel, getTaskStatusLabel } from './task-display.js';
import { textResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleSearchTasks(
  params: {
    query?: string;
    pullRequest?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await searchTasks(config, {
      query: params.query,
      pullRequest: params.pullRequest,
      status: params.status,
      limit: params.limit,
      cursor: params.cursor,
    });

    if (result.tasks.length === 0) {
      return textResult('No tasks found matching your search criteria.');
    }

    const lines = result.tasks.map((task, index) => {
      const title = task.title || '(untitled)';
      const harnessLabel = getHarnessLabel(task.harness);

      const segments = [
        task.repositoryName ? `repo: ${task.repositoryName}` : null,
        harnessLabel ? `harness: ${harnessLabel}` : null,
        task.taskRunError ? `error: ${task.taskRunError}` : null,
      ].filter(Boolean);

      return `${index + 1}. [${getTaskStatusLabel(task)}] ${title} (id: ${task.id})${segments.length > 0 ? ` | ${segments.join(' | ')}` : ''}`;
    });

    const summaryLines = [
      `Found ${result.tasks.length} task(s)${result.hasMore ? ' (more available)' : ''}:`,
      '',
      ...lines,
    ];

    if (result.hasMore && result.nextCursor !== undefined) {
      summaryLines.push(
        '',
        `Next cursor: ${result.nextCursor} (pass as cursor to fetch the next page).`,
      );
    }

    return textResult(summaryLines.join('\n'));
  } catch (error) {
    return catchError(error);
  }
}
