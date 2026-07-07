import { handleSubmitAutomationWorkItems } from '../submit-automation-work-items.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleSubmitAutomationWorkItems', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forwards act work items to the platform API client', async () => {
    vi.mocked(tasksApiClient.submitAutomationWorkItems).mockResolvedValueOnce({
      success: true,
      workItemCount: 2,
      actedCount: 2,
      launchedCount: 2,
      failedCount: 0,
      duplicateCount: 0,
    });

    const result = await handleSubmitAutomationWorkItems(
      {
        taskId: 'task-123',
        workItems: [
          {
            title: 'Fix API request body parsing',
            brief:
              'A malformed payload path is causing repeated Sentry errors.',
            category: 'bug',
            priority: 'P1',
            actionKind: 'code_change_pr',
            disposition: 'act',
            investigationContext:
              '$sentry-triage\nIssue: SENTRY-123\nRepro confirms the parser throws before validation.',
            executionPrompt:
              'Reproduce the error, fix the parsing path, add regression coverage, and open a PR.',
            targetRepositoryFullName: 'acme/app',
            targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
            workspaceReadiness: 'environment_backed',
          },
          {
            title: 'Mute duplicate noisy Sentry group',
            brief: 'This issue is a duplicate of the canonical parser failure.',
            category: 'chore',
            actionKind: 'sentry_issue_mutation',
            disposition: 'act',
            investigationContext:
              '$sentry-triage\nIssue: SENTRY-456\nVerified duplicate of SENTRY-123.',
            executionPrompt:
              'Re-verify the duplicate relationship, then merge the Sentry groups.',
            targetRepositoryFullName: 'acme/app',
            workspaceReadiness: 'bare_repo',
          },
        ],
      },
      config,
    );

    expect(tasksApiClient.submitAutomationWorkItems).toHaveBeenCalledWith(
      config,
      'task-123',
      {
        workItems: [
          expect.objectContaining({
            actionKind: 'code_change_pr',
            disposition: 'act',
          }),
          expect.objectContaining({
            actionKind: 'sentry_issue_mutation',
            disposition: 'act',
          }),
        ],
      },
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.workItemCount).toBe(2);
    expect(parsed.actedCount).toBe(2);
    expect(parsed.launchedCount).toBe(2);
  });
});
