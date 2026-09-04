import { handleSendMessage } from '../send-message.js';
import { TaskPayloadKind } from '@roomote/types';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleSendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should return success when message is sent', async () => {
    vi.mocked(tasksApiClient.steerMessageToTask).mockResolvedValueOnce({
      success: true,
      result: { sent: true },
    });

    const result = await handleSendMessage(
      { taskId: 'task-1', message: 'Please continue' },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('task-1');
    expect(parsed.sent).toEqual({
      direction: 'Codex → Roomote',
      target: { kind: 'task', id: 'task-1' },
      text: 'Please continue',
    });
    expect(tasksApiClient.steerMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message: 'Please continue',
        images: undefined,
      },
    );
    expect(tasksApiClient.sendMessageToTask).not.toHaveBeenCalled();
  });

  it('surfaces snapshot resumes with the new task run id', async () => {
    vi.mocked(tasksApiClient.steerMessageToTask).mockResolvedValueOnce({
      success: true,
      result: { resumed: true, runId: 77, taskId: 'task-1' },
    });

    const result = await handleSendMessage(
      { taskId: 'task-1', message: 'Please continue' },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      success: true,
      message: 'Task task-1 is resuming from snapshot.',
      resumed: true,
      runId: 77,
      taskId: 'task-1',
      sent: {
        direction: 'Codex → Roomote',
        target: { kind: 'task', id: 'task-1' },
        text: 'Please continue',
      },
    });
    expect(tasksApiClient.steerMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message: 'Please continue',
        images: undefined,
      },
    );
    expect(tasksApiClient.sendMessageToTask).not.toHaveBeenCalled();
  });

  it('should return error when API returns success=false', async () => {
    vi.mocked(tasksApiClient.steerMessageToTask).mockResolvedValueOnce({
      success: false,
      error: 'Task is not active',
    });

    const result = await handleSendMessage(
      { taskId: 'task-1', message: 'Hello' },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Task is not active');
    expect(tasksApiClient.sendMessageToTask).not.toHaveBeenCalled();
  });

  it('should return error on exception', async () => {
    vi.mocked(tasksApiClient.steerMessageToTask).mockRejectedValueOnce(
      new Error('Connection refused'),
    );

    const result = await handleSendMessage(
      { taskId: 'task-1', message: 'Hello' },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Connection refused');
    expect(tasksApiClient.sendMessageToTask).not.toHaveBeenCalled();
  });

  it('passes linked review handoff senderMode for review-result relays', async () => {
    vi.stubEnv('ROOMOTE_TASK_TYPE', TaskPayloadKind.GithubPrReview);
    vi.mocked(tasksApiClient.sendMessageToTask).mockResolvedValueOnce({
      success: true,
      result: { sent: true },
    });

    await handleSendMessage(
      {
        taskId: 'task-1',
        message: '<review_result>Looks good</review_result>',
      },
      config,
    );

    expect(tasksApiClient.sendMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message: '<review_result>Looks good</review_result>',
        images: undefined,
        senderMode: 'linked_review_handoff',
      },
    );
    expect(tasksApiClient.steerMessageToTask).not.toHaveBeenCalled();
  });

  it('passes linked review handoff senderMode for attribute-based review-result relays', async () => {
    vi.stubEnv('ROOMOTE_TASK_TYPE', TaskPayloadKind.GithubPrReviewSync);
    vi.mocked(tasksApiClient.sendMessageToTask).mockResolvedValueOnce({
      success: true,
      result: { sent: true },
    });

    await handleSendMessage(
      {
        taskId: 'task-1',
        message: '<review_result type="send">No new delta</review_result>',
      },
      config,
    );

    expect(tasksApiClient.sendMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message: '<review_result type="send">No new delta</review_result>',
        images: undefined,
        senderMode: 'linked_review_handoff',
      },
    );
    expect(tasksApiClient.steerMessageToTask).not.toHaveBeenCalled();
  });

  it('keeps linked review handoff senderMode for legacy code-review-results relays', async () => {
    vi.stubEnv('ROOMOTE_TASK_TYPE', TaskPayloadKind.GithubPrReviewSync);
    vi.mocked(tasksApiClient.sendMessageToTask).mockResolvedValueOnce({
      success: true,
      result: { sent: true },
    });

    await handleSendMessage(
      {
        taskId: 'task-1',
        message:
          '<code-review-results type="send">No new delta</code-review-results>',
      },
      config,
    );

    expect(tasksApiClient.sendMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message:
          '<code-review-results type="send">No new delta</code-review-results>',
        images: undefined,
        senderMode: 'linked_review_handoff',
      },
    );
    expect(tasksApiClient.steerMessageToTask).not.toHaveBeenCalled();
  });

  it('surfaces skipped linked review handoffs as a successful no-op', async () => {
    vi.stubEnv('ROOMOTE_TASK_TYPE', TaskPayloadKind.GithubPrReviewSync);
    vi.mocked(tasksApiClient.sendMessageToTask).mockResolvedValueOnce({
      success: true,
      result: {
        skipped: true,
        reason:
          'Linked review handoff skipped because the pull request is no longer open.',
      },
    });

    const result = await handleSendMessage(
      {
        taskId: 'task-1',
        message: '<code-review-results>No new delta</code-review-results>',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe(
      'Linked review handoff skipped because the pull request is no longer open.',
    );
    expect(parsed).not.toHaveProperty('sent');
    expect(tasksApiClient.sendMessageToTask).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        message: '<code-review-results>No new delta</code-review-results>',
        images: undefined,
        senderMode: 'linked_review_handoff',
      },
    );
    expect(tasksApiClient.steerMessageToTask).not.toHaveBeenCalled();
  });
});
