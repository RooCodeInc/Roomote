import { buildAgentMailButtonSections } from '../agentmail-format';

describe('buildAgentMailButtonSections', () => {
  it('renders url buttons as anchors and a plain-text link list', () => {
    const sections = buildAgentMailButtonSections([
      [
        { text: 'Quick fix', url: 'https://app.example/answer?token=a' },
        { text: 'Full refactor', url: 'https://app.example/answer?token=b' },
      ],
    ]);

    expect(sections.html).toContain(
      '<a href="https://app.example/answer?token=a"',
    );
    expect(sections.html).toContain('Full refactor</a>');
    expect(sections.text).toContain(
      'Quick fix: https://app.example/answer?token=a',
    );
  });

  it('escapes labels and urls in the html output', () => {
    const sections = buildAgentMailButtonSections([
      [{ text: '<b>Yes</b> & no', url: 'https://x.example/?a=1&b=2' }],
    ]);

    expect(sections.html).toContain('&lt;b&gt;Yes&lt;/b&gt; &amp; no');
    expect(sections.html).toContain('https://x.example/?a=1&amp;b=2');
    expect(sections.html).not.toContain('<b>Yes</b>');
  });

  it('returns empty sections when no button has a url', () => {
    expect(
      buildAgentMailButtonSections([[{ text: 'No link', url: '' }]]),
    ).toEqual({ html: '', text: '' });
  });
});
