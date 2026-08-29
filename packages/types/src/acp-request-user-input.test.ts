import {
  parseAcpRequestUserInputAnswers,
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

    expect(question?.selectionMode).toBeUndefined();
    expect(question?.minSelections).toBeUndefined();
  });

  it('parses multiple mode with minimum selections and clamps against options', () => {
    const question = parseAcpRequestUserInputQuestion({
      ...singleQuestion,
      selectionMode: 'multiple',
      minSelections: 2,
    });

    expect(question?.selectionMode).toBe('multiple');
    expect(question?.minSelections).toBe(2);
  });

  it('clamps minimum selections against the available option count', () => {
    const question = parseAcpRequestUserInputQuestion({
      ...singleQuestion,
      selectionMode: 'multiple',
      minSelections: 99,
    });

    expect(question?.minSelections).toBe(2);
  });

  it('keeps single mode even when minSelections is present', () => {
    const question = parseAcpRequestUserInputQuestion({
      ...singleQuestion,
      minSelections: 2,
    });

    expect(question?.selectionMode ?? 'single').toBe('single');
    expect(question?.minSelections).toBeUndefined();
  });

  it('parses request params with multi-select metadata intact', () => {
    const params = parseAcpRequestUserInputRequestParams({
      sessionId: 's',
      turnId: 't',
      callId: 'c',
      questions: [
        {
          ...singleQuestion,
          selectionMode: 'multiple',
          minSelections: 1,
        },
      ],
    });

    expect(params?.questions[0]?.selectionMode).toBe('multiple');
    expect(params?.questions[0]?.minSelections).toBe(1);
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
