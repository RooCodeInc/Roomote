import type { IncomingMessage, ServerResponse } from 'node:http';
import { RunStatus } from '@roomote/types';

import { mockConfig } from '../../__tests__/fixtures';

const TEST_PREVIEW_TASK_ID = '123456789abcd';
const TEST_PREVIEW_HOST = `${TEST_PREVIEW_TASK_ID}-web.preview.roomote.dev`;

const { mockFindTaskRun, mockValidatePreviewToken } = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockValidatePreviewToken: vi.fn(),
}));

vi.mock('../../config', () => ({
  config: mockConfig,
}));

vi.mock('../../lib/db', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
    },
  },
}));

vi.mock('@roomote/auth', () => ({
  validatePreviewToken: mockValidatePreviewToken,
}));

vi.mock('@roomote/db/server', () => ({
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
  },
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ['eq', column, value],
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
  },
  escapeForLog: (value: string) => value,
}));

import { handleResumeStatusRequest } from '../resume-status';

function createRequest(host = TEST_PREVIEW_HOST): IncomingMessage {
  return {
    headers: {
      host,
      cookie: `${mockConfig.PREVIEW_AUTH_COOKIE_NAME}=viewer-two-token`,
    },
  } as IncomingMessage;
}

function createResponse() {
  const writeHead = vi.fn();
  const end = vi.fn();

  return {
    response: { writeHead, end } as unknown as ServerResponse,
    writeHead,
    end,
  };
}

describe('handleResumeStatusRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidatePreviewToken.mockResolvedValue({
      userId: 'viewer-two',
      tokenType: 'pt',
      version: 1,
    });
    mockFindTaskRun.mockResolvedValue({
      id: 101,
      status: RunStatus.Running,
      error: null,
      machineId: null,
    });
  });

  it('lets another authenticated task viewer poll the winning resume run', async () => {
    const { response, writeHead, end } = createResponse();

    await handleResumeStatusRequest(createRequest(), response, '101');

    expect(mockFindTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          ['eq', 'taskRuns.id', 101],
          ['eq', 'taskRuns.taskId', TEST_PREVIEW_TASK_ID],
        ]),
      }),
    );
    expect(writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
    });
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        status: RunStatus.Running,
        error: null,
        ready: false,
      }),
    );
  });

  it('does not expose a resume run through another task preview host', async () => {
    mockFindTaskRun.mockResolvedValue(null);
    const { response, writeHead, end } = createResponse();

    await handleResumeStatusRequest(
      createRequest('0000000000001-web.preview.roomote.dev'),
      response,
      '101',
    );

    expect(mockFindTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          ['eq', 'taskRuns.id', 101],
          ['eq', 'taskRuns.taskId', '0000000000001'],
        ]),
      }),
    );
    expect(writeHead).toHaveBeenCalledWith(404, {
      'Content-Type': 'application/json',
    });
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'Run not found' }),
    );
  });
});
