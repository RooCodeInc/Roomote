import {
  formatRequestUserInputResponseText,
  getAcpRequestUserInputValidationError,
  normalizeAcpRequestUserInputAnswers,
  parseAcpRequestUserInputAnswers,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputQuestion,
  parseAcpRequestUserInputRequestParams,
  parseAcpRequestUserInputResponsePayload,
  resolveAcpRequestUserInputAnswer,
} from './acp';

const singleQuestion = {
  id: 'mode',
  header: 'Mode',
  question: 'Pick one.',
  isOther: false,
  isSecret: false,
  options: [
    { label: 'Fast', description: 'Run fast' },
    { label: 'Thorough', description: 'Run thoroughly' },
  ],
};

describe('request_user_input multi-select payloads', () => {
  it('preserves legacy and multi-select question payload behavior', () => {
    const question = parseAcpRequestUserInputQuestion(singleQuestion);
    expect(question?.multiple).toBeUndefined();
    expect(
      getAcpRequestUserInputValidationError([singleQuestion], {
        mode: { answers: ['Fast', 'Thorough'] },
      }),
    ).toBe('This question accepts a single answer.');
    expect(
      getAcpRequestUserInputValidationError(
        [{ ...singleQuestion, multiple: true }],
        { mode: { answers: ['Fast', 'Thorough'] } },
      ),
    ).toBeNull();
    expect(
      getAcpRequestUserInputValidationError(
        [{ ...singleQuestion, isOther: true }],
        { mode: { answers: ['Balanced'] } },
      ),
    ).toBeNull();
    expect(
      getAcpRequestUserInputValidationError(
        [{ ...singleQuestion, isOther: true, multiple: true }],
        { mode: { answers: ['Balanced', 'Careful'] } },
      ),
    ).toBe('One or more selections are not valid options.');
    expect(
      parseAcpRequestUserInputQuestion({ ...singleQuestion, multiple: true })
        ?.multiple,
    ).toBe(true);
    expect(
      parseAcpRequestUserInputQuestion({
        ...singleQuestion,
        selectionMode: 'multiple',
        minSelections: 99,
      })?.multiple,
    ).toBeUndefined();
    const params = parseAcpRequestUserInputRequestParams({
      sessionId: 's',
      turnId: 't',
      callId: 'c',
      questions: [
        {
          ...singleQuestion,
          multiple: true,
        },
      ],
    });

    expect(params?.questions[0]?.multiple).toBe(true);
  });

  it('preserves only trusted setup presets on request payloads', () => {
    const payload = {
      requestId: 'r',
      sessionId: 's',
      turnId: 't',
      callId: 'c',
      questions: [singleQuestion],
    };

    expect(
      parseAcpRequestUserInputPayload({
        ...payload,
        preset: 'setup_source_control',
      })?.preset,
    ).toBe('setup_source_control');
    expect(
      parseAcpRequestUserInputPayload({
        ...payload,
        preset: 'setup_starter_tasks',
      })?.preset,
    ).toBe('setup_starter_tasks');
    expect(
      parseAcpRequestUserInputPayload({
        ...payload,
        preset: 'setup_integrations',
        questions: [
          {
            ...singleQuestion,
            options: [
              { id: 'slack', label: 'Slack', description: 'Connect Slack' },
            ],
          },
        ],
      }),
    ).toMatchObject({
      preset: 'setup_integrations',
      questions: [{ options: [{ id: 'slack', label: 'Slack' }] }],
    });
    expect(
      parseAcpRequestUserInputPayload({ ...payload, preset: 'untrusted' })
        ?.preset,
    ).toBeUndefined();
  });

  it('canonicalizes trusted option IDs while accepting legacy labels', () => {
    const question = {
      ...singleQuestion,
      options: [
        { id: 'fast', label: 'Fast', description: 'Run fast' },
        {
          id: 'thorough',
          label: 'Thorough',
          description: 'Run thoroughly',
        },
      ],
    };
    expect(
      getAcpRequestUserInputValidationError([question], {
        mode: { answers: ['fast'] },
      }),
    ).toBeNull();
    expect(
      normalizeAcpRequestUserInputAnswers([question], {
        mode: { answers: ['Fast'] },
      }),
    ).toEqual({ mode: { answers: ['fast'] } });
    expect(resolveAcpRequestUserInputAnswer(question, 'Fast')).toBe('fast');
    expect(resolveAcpRequestUserInputAnswer(question, '2')).toBe('thorough');
  });

  it('preserves labels for legacy options without IDs', () => {
    expect(
      normalizeAcpRequestUserInputAnswers([singleQuestion], {
        mode: { answers: ['Fast'] },
      }),
    ).toEqual({ mode: { answers: ['Fast'] } });
    expect(resolveAcpRequestUserInputAnswer(singleQuestion, '1')).toBe('Fast');
  });

  it('parses answers and response payloads without multi-select changes', () => {
    const answers = parseAcpRequestUserInputAnswers({
      mode: { answers: ['Fast'] },
      broken: { answers: 'not-an-array' },
    });
    expect(answers).toEqual({ mode: { answers: ['Fast'] } });

    const response = parseAcpRequestUserInputResponsePayload({
      requestId: 'r',
      sessionId: 's',
      turnId: 't',
      callId: 'c',
      answers: { mode: { answers: ['Fast'] } },
      resolution: 'submitted',
    });
    expect(response?.resolution).toBe('submitted');
    expect(
      parseAcpRequestUserInputResponsePayload({
        ...response,
        resolution: 'cancelled',
      })?.resolution,
    ).toBe('cancelled');
    expect(
      parseAcpRequestUserInputResponsePayload({ requestId: 'partial' }),
    ).toBeNull();
  });
});

describe('request_user_input response transcript formatting', () => {
  const request = {
    requestId: 'r',
    sessionId: 's',
    turnId: 't',
    callId: 'c',
    status: 'pending' as const,
    questions: [
      {
        ...singleQuestion,
        isOther: true,
        options: [
          { id: 'fast', label: 'Fast', description: 'Run fast' },
          {
            id: 'thorough',
            label: 'Thorough',
            description: 'Run thoroughly',
          },
        ],
      },
    ],
  };

  it('formats submitted answers without mutating or revealing secrets', () => {
    const response = {
      resolution: 'submitted' as const,
      answers: { mode: { answers: ['fast'] } },
    };

    expect(formatRequestUserInputResponseText(request, response)).toBe('Fast');
    expect(response.answers.mode.answers).toEqual(['fast']);
    expect(
      formatRequestUserInputResponseText(request, {
        resolution: 'submitted',
        answers: { mode: { answers: ['Use balanced mode'] } },
      }),
    ).toBe('Use balanced mode');
    expect(
      formatRequestUserInputResponseText(request, {
        resolution: 'submitted',
        answers: { mode: { answers: ['Fast'] } },
      }),
    ).toBe('Fast');
    expect(
      formatRequestUserInputResponseText(request, {
        resolution: 'submitted',
        answers: { mode: { answers: ['1'] } },
      }),
    ).toBe('1');
    expect(
      formatRequestUserInputResponseText(
        {
          ...request,
          questions: [
            {
              ...singleQuestion,
              options: [
                {
                  id: 'continue',
                  label: 'Continue',
                  description: 'Continue setup.',
                },
              ],
            },
          ],
        },
        {
          resolution: 'submitted',
          answers: { mode: { answers: ['continue'] } },
        },
      ),
    ).toBe('Continue');
    expect(
      formatRequestUserInputResponseText(
        {
          ...request,
          questions: [
            {
              ...singleQuestion,
              multiple: true,
              options: [
                { id: 'slack', label: 'Slack', description: 'Connect Slack' },
                {
                  id: 'notion',
                  label: 'Notion',
                  description: 'Connect Notion',
                },
              ],
            },
          ],
        },
        {
          resolution: 'submitted',
          answers: { mode: { answers: ['slack', 'notion'] } },
        },
      ),
    ).toBe('Slack, Notion');
    expect(
      formatRequestUserInputResponseText(
        {
          ...request,
          questions: [{ ...request.questions[0]!, isSecret: true }],
        },
        {
          resolution: 'submitted',
          answers: { mode: { answers: ['fast'] } },
        },
      ),
    ).toBe('[hidden]');
  });
});
