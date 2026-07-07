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
    expect(parsed.error).toContain('String must contain at least 1 character');
  });
});
