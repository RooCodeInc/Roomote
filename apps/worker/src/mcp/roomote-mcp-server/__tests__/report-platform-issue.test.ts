import { handleReportPlatformIssue } from '../report-platform-issue.js';

describe('handleReportPlatformIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success with the normalized report', async () => {
    const result = await handleReportPlatformIssue({
      title: '  Missing Slack access  ',
      summary: '  The Slack app is not in the configured channel.  ',
    });

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed).toEqual({
      success: true,
      reportCreated: true,
      report: {
        title: 'Missing Slack access',
        summary: 'The Slack app is not in the configured channel.',
      },
    });
  });

  it('returns an error when the input is invalid', async () => {
    const result = await handleReportPlatformIssue({
      title: '',
      summary: '',
    });

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(JSON.parse(parsed.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'too_small',
          minimum: 1,
          path: ['title'],
        }),
        expect.objectContaining({
          code: 'too_small',
          minimum: 1,
          path: ['summary'],
        }),
      ]),
    );
  });
});
