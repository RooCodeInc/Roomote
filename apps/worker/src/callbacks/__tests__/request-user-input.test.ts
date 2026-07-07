import type { CloudJob } from '@roomote/sdk/client';

import {
  buildRequestUserInputTaskUrl,
  formatRequestUserInputPrompt,
} from '../request-user-input';

describe('formatRequestUserInputPrompt', () => {
  it('keeps a single question out of the numbered options list', () => {
    const prompt = formatRequestUserInputPrompt({
      requestId: 'rui:session:turn:call',
      sessionId: 'session_1',
      turnId: 'turn_1',
      callId: 'call_1',
      status: 'pending',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the existing app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });

    expect(prompt).toBe(
      [
        'Which language should I use?',
        '1. TypeScript — Use the existing app stack.',
        '2. Rust — Use the OpenCode runtime.',
        '',
        'Reply with an option number, the option label, your own custom answer, or `cancel` to skip.',
      ].join('\n'),
    );
  });

  it('labels multiple questions without turning them into option numbers', () => {
    const prompt = formatRequestUserInputPrompt({
      requestId: 'rui:session:turn:call',
      sessionId: 'session_1',
      turnId: 'turn_1',
      callId: 'call_1',
      status: 'pending',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: false,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the existing app stack.',
            },
          ],
        },
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which stack should I inspect first?',
          isOther: false,
          isSecret: false,
          options: [
            {
              label: 'App',
              description: 'Start from the web app.',
            },
          ],
        },
      ],
    });

    expect(prompt).toContain('Question 1: Which language should I use?');
    expect(prompt).toContain('Question 2: Which stack should I inspect first?');
    expect(prompt).not.toContain('1. Which language should I use?');
    expect(prompt).not.toContain('2. Which stack should I inspect first?');
  });

  it('does not invite custom answers for fixed-choice single-question prompts', () => {
    const prompt = formatRequestUserInputPrompt({
      requestId: 'rui:session:turn:call',
      sessionId: 'session_1',
      turnId: 'turn_1',
      callId: 'call_1',
      status: 'pending',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: false,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the existing app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });

    expect(prompt).toContain(
      'Reply with an option number, the option label, or `cancel` to skip.',
    );
    expect(prompt).not.toContain('your own custom answer');
  });

  it('formats four-question prompts without truncating later questions', () => {
    const prompt = formatRequestUserInputPrompt({
      requestId: 'rui:session:turn:call',
      sessionId: 'session_1',
      turnId: 'turn_1',
      callId: 'call_1',
      status: 'pending',
      questions: [
        {
          id: 'q1',
          header: 'First',
          question: 'Question one?',
          isOther: false,
          isSecret: false,
        },
        {
          id: 'q2',
          header: 'Second',
          question: 'Question two?',
          isOther: false,
          isSecret: false,
        },
        {
          id: 'q3',
          header: 'Third',
          question: 'Question three?',
          isOther: false,
          isSecret: false,
        },
        {
          id: 'q4',
          header: 'Fourth',
          question: 'Question four?',
          isOther: false,
          isSecret: false,
        },
      ],
    });

    expect(prompt).toContain('Question 1: Question one?');
    expect(prompt).toContain('Question 2: Question two?');
    expect(prompt).toContain('Question 3: Question three?');
    expect(prompt).toContain('Question 4: Question four?');
  });
});

describe('buildRequestUserInputTaskUrl', () => {
  const originalRoomoteAppUrl = process.env.ROOMOTE_APP_URL;
  const localOrigin = 'http://localhost:13000';

  beforeEach(() => {
    process.env.ROOMOTE_APP_URL = localOrigin;
  });

  afterAll(() => {
    if (originalRoomoteAppUrl === undefined) {
      delete process.env.ROOMOTE_APP_URL;
    } else {
      process.env.ROOMOTE_APP_URL = originalRoomoteAppUrl;
    }
  });

  function makeCloudJob(payload: unknown): CloudJob {
    return {
      taskId: 'task-123',
      payload,
    } as CloudJob;
  }

  it('builds a task URL when no webPath override exists', () => {
    const url = buildRequestUserInputTaskUrl(
      makeCloudJob({ repo: 'owner/repo' }),
      'slack',
    );

    expect(url).toBe(
      `${localOrigin}/task/task-123?utm_source=slack&utm_medium=integration&utm_campaign=request_user_input`,
    );
  });

  it('uses payload.webPath for setup-onboarding requests', () => {
    const url = buildRequestUserInputTaskUrl(
      makeCloudJob({ webPath: '/setup' }),
      'slack',
    );

    expect(url).toBe(
      `${localOrigin}/setup?utm_source=slack&utm_medium=integration&utm_campaign=request_user_input`,
    );
  });
});
