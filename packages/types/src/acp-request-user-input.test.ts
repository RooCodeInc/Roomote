import {
  parseAcpRequestUserInputAnswers,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputQuestion,
  parseAcpRequestUserInputRequestParams,
  parseAcpRequestUserInputResponsePayload,
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
  it('defaults legacy questions to single mode without multi-select fields', () => {
    const question = parseAcpRequestUserInputQuestion(singleQuestion);

    expect(question?.multiple).toBeUndefined();
  });

  it('parses explicit multiple mode', () => {
    const question = parseAcpRequestUserInputQuestion({
      ...singleQuestion,
      multiple: true,
    });

    expect(question?.multiple).toBe(true);
  });

  it('ignores removed selectionMode and minSelections fields', () => {
    const question = parseAcpRequestUserInputQuestion({
      ...singleQuestion,
      selectionMode: 'multiple',
      minSelections: 99,
    });

    expect(question?.multiple).toBeUndefined();
  });

  it('parses request params with multi-select metadata intact', () => {
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
        preset: 'setup_starter_tasks',
      })?.preset,
    ).toBe('setup_starter_tasks');
    expect(
      parseAcpRequestUserInputPayload({ ...payload, preset: 'untrusted' })
        ?.preset,
    ).toBeUndefined();
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
