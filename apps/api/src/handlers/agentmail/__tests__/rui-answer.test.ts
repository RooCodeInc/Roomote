import { randomUUID } from 'node:crypto';

import {
  getPendingCommunicationRequestUserInput,
  setPendingCommunicationRequestUserInput,
} from '@roomote/communication';
import { db, taskFactory, taskRuns, userFactory } from '@roomote/db/server';
import {
  buildAgentMailRuiAnswerToken,
  buildAgentMailRuiAnswerUrl,
  verifyAgentMailRuiAnswerToken,
} from '@roomote/sdk/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { agentmail } from '../index.js';

async function createRun(): Promise<number> {
  const task = await taskFactory.create();
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      payload: { repo: 'acme/repo', description: 'test' },
    })
    .returning({ id: taskRuns.id });
  if (!run) throw new Error('run insert failed');
  return run.id;
}

describe('agentmail one-click request_user_input answers', () => {
  it('round-trips and rejects tampered or expired tokens', () => {
    const token = buildAgentMailRuiAnswerToken({
      conversationId: 'conv-1',
      requestId: 'req-1',
      questionId: 'q-1',
      optionIndex: 0,
      userId: 'user-1',
    });
    expect(verifyAgentMailRuiAnswerToken(token)).toMatchObject({
      conversationId: 'conv-1',
      requestId: 'req-1',
      optionIndex: 0,
      userId: 'user-1',
    });

    expect(verifyAgentMailRuiAnswerToken(`${token}x`)).toBeNull();

    const expired = buildAgentMailRuiAnswerToken({
      conversationId: 'conv-1',
      requestId: 'req-1',
      questionId: 'q-1',
      optionIndex: 0,
      userId: 'user-1',
      expiresAtMs: Date.now() - 1_000,
    });
    expect(verifyAgentMailRuiAnswerToken(expired)).toBeNull();
  });

  it('records the answer atomically and treats the second click as already answered', async () => {
    const user = await userFactory.create();
    const runId = await createRun();
    const conversationId = randomUUID();
    const requestId = `req-${randomUUID()}`;
    const questions = [
      {
        id: 'approach',
        header: 'Approach',
        question: 'Which approach should I take?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Quick fix', description: 'Patch it' },
          { label: 'Full refactor', description: 'Do it properly' },
        ],
      },
    ];

    await setPendingCommunicationRequestUserInput('agentmail', conversationId, {
      requestId,
      runId,
      taskId: 'task-unused',
      questions,
      currentQuestionIndex: 0,
    });

    const url = new URL(
      buildAgentMailRuiAnswerUrl(
        buildAgentMailRuiAnswerToken({
          conversationId,
          requestId,
          questionId: 'approach',
          optionIndex: 1,
          userId: user.id,
        }),
      ),
    );

    const first = await agentmail.request(`/answer${url.search}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Answer recorded: Full refactor');

    const pending = await getPendingCommunicationRequestUserInput(
      'agentmail',
      conversationId,
    );
    expect(pending?.status).toBe('submitted');

    const second = await agentmail.request(`/answer${url.search}`);
    expect(await second.text()).toContain('Already answered');
  });

  it('rejects a token for a superseded request', async () => {
    const user = await userFactory.create();
    const runId = await createRun();
    const conversationId = randomUUID();

    await setPendingCommunicationRequestUserInput('agentmail', conversationId, {
      requestId: 'req-new',
      runId,
      taskId: 'task-unused',
      questions: [
        {
          id: 'q',
          header: 'Continue',
          question: 'Continue?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Yes', description: 'Proceed' }],
        },
      ],
      currentQuestionIndex: 0,
    });

    const url = new URL(
      buildAgentMailRuiAnswerUrl(
        buildAgentMailRuiAnswerToken({
          conversationId,
          requestId: 'req-old',
          questionId: 'q',
          optionIndex: 0,
          userId: user.id,
        }),
      ),
    );

    const response = await agentmail.request(`/answer${url.search}`);
    expect(await response.text()).toContain('no longer active');
  });
});
