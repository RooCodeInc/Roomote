import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { waitCurrentTask } = vi.hoisted(() => ({ waitCurrentTask: vi.fn() }));

vi.mock('../tasks-api-client', () => ({ waitCurrentTask }));

import { handleWaitTask } from '../wait-task';

describe('wait task tool', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-wait-'));
    process.env.ROOMOTE_TASK_RUN_ID = '42';
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL = 'https://platform.example.com';
    process.env.ROOMOTE_TASK_WAIT_STATE_FILE = path.join(tempDir, 'wait.json');
    delete process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('schedules a wait and records local completion state', async () => {
    waitCurrentTask.mockResolvedValue({
      scheduled: true,
      waitUntil: '2026-08-13T16:00:00.000Z',
    });

    const result = await handleWaitTask({
      delaySeconds: 1_800,
      reason: 'Check deployment',
    });

    expect(waitCurrentTask).toHaveBeenCalledWith(expect.any(Object), 42, {
      delaySeconds: 1_800,
      reason: 'Check deployment',
    });
    expect(
      JSON.parse(
        fs.readFileSync(process.env.ROOMOTE_TASK_WAIT_STATE_FILE!, 'utf8'),
      ),
    ).toMatchObject({ scheduled: true });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('post the paused-state closeout'),
    });
  });

  it('rejects waits below ten minutes', async () => {
    const result = await handleWaitTask({ delaySeconds: 60, reason: 'Check' });

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('between 600'),
    });
    expect(waitCurrentTask).not.toHaveBeenCalled();
  });

  it('does not mark the turn waiting when the platform rejects the schedule', async () => {
    waitCurrentTask.mockResolvedValue({
      scheduled: false,
      reason: 'unsupported',
      waitUntil: null,
    });

    const result = await handleWaitTask({
      delaySeconds: 1_800,
      reason: 'Check deployment',
    });

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('unsupported'),
    });
    expect(fs.existsSync(process.env.ROOMOTE_TASK_WAIT_STATE_FILE!)).toBe(
      false,
    );
  });
});
