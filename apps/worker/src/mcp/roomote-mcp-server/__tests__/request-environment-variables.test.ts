import { handleRequestEnvironmentVariables } from '../request-environment-variables.js';

describe('handleRequestEnvironmentVariables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success with the requested names', async () => {
    const result = await handleRequestEnvironmentVariables({
      variables: [
        {
          name: 'OPENAI_API_KEY',
        },
      ],
    });

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed).toEqual({
      success: true,
      requestCreated: true,
      requestedNames: ['OPENAI_API_KEY'],
      taskStopRequested: false,
    });
  });

  it('marks the task for a follow-up stop when task context is available', async () => {
    const result = await handleRequestEnvironmentVariables(
      {
        variables: [
          {
            name: 'OPENAI_API_KEY',
          },
        ],
      },
      {
        taskId: 'task-123',
      },
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed).toEqual({
      success: true,
      requestCreated: true,
      requestedNames: ['OPENAI_API_KEY'],
      taskStopRequested: true,
    });
  });

  it('returns an error when the input is invalid', async () => {
    const result = await handleRequestEnvironmentVariables({
      variables: [],
    });

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('At least one environment variable');
  });
});
