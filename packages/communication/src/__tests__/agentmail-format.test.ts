import { describe, expect, it } from 'vitest';

import {
  AGENTMAIL_MAX_TEXT_LENGTH,
  buildAgentMailEmailBody,
  renderAgentMailHtml,
  renderAgentMailPlainText,
} from '../agentmail-format';

describe('renderAgentMailHtml', () => {
  it('converts bold, italic, and inline code inside a paragraph', () => {
    expect(renderAgentMailHtml('**bold** and *italic* and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
  });

  it('escapes HTML so script injection stays inert', () => {
    expect(renderAgentMailHtml('<script>alert("x")</script>')).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>',
    );
  });

  it('converts http and mailto links to anchors', () => {
    expect(
      renderAgentMailHtml(
        '[the task](https://example.test/t/1) or [mail us](mailto:hi@example.test)',
      ),
    ).toBe(
      '<p><a href="https://example.test/t/1">the task</a> or <a href="mailto:hi@example.test">mail us</a></p>',
    );
  });

  it('leaves unsafe link protocols as escaped text', () => {
    expect(renderAgentMailHtml('[click](javascript:alert(1))')).toBe(
      '<p>[click](javascript:alert(1))</p>',
    );
  });

  it('renders headings one size down as h3-h5', () => {
    expect(renderAgentMailHtml('# One\n\n## Two\n\n### Three')).toBe(
      '<h3>One</h3><h4>Two</h4><h5>Three</h5>',
    );
  });

  it('renders unordered and ordered lists', () => {
    expect(renderAgentMailHtml('- a\n- b\n\n1. x\n2. y')).toBe(
      '<ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>',
    );
  });

  it('renders blockquotes', () => {
    expect(renderAgentMailHtml('> quoted line')).toBe(
      '<blockquote><p>quoted line</p></blockquote>',
    );
  });

  it('renders fenced code blocks with escaped content', () => {
    expect(renderAgentMailHtml('```ts\nconst a = 1 < 2;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
  });

  it('joins adjacent paragraph lines with line breaks', () => {
    expect(renderAgentMailHtml('line one\nline two')).toBe(
      '<p>line one<br />line two</p>',
    );
  });

  it('leaves emphasis markers inside code spans untouched', () => {
    expect(renderAgentMailHtml('`**not bold**` but **bold**')).toBe(
      '<p><code>**not bold**</code> but <strong>bold</strong></p>',
    );
  });

  it('does not italicize snake_case identifiers', () => {
    expect(renderAgentMailHtml('set R_AGENTMAIL_API_KEY and my_var_name')).toBe(
      '<p>set R_AGENTMAIL_API_KEY and my_var_name</p>',
    );
  });
});

describe('renderAgentMailPlainText', () => {
  it('renders links as label (url)', () => {
    expect(
      renderAgentMailPlainText('see [the task](https://example.test/t/1)'),
    ).toBe('see the task (https://example.test/t/1)');
  });

  it('strips emphasis, code, and heading markers', () => {
    expect(
      renderAgentMailPlainText('## Summary\n**done** with `it` and *more*'),
    ).toBe('Summary\ndone with it and more');
  });

  it('keeps fenced code content verbatim', () => {
    expect(renderAgentMailPlainText('```\nconst a = 1;\n```')).toBe(
      'const a = 1;',
    );
  });

  it('strips blockquote markers', () => {
    expect(renderAgentMailPlainText('> quoted line')).toBe('quoted line');
  });
});

describe('buildAgentMailEmailBody', () => {
  it('wraps the html body in a minimal div and pairs it with plain text', () => {
    expect(buildAgentMailEmailBody('**hi** there')).toEqual({
      html: '<div><p><strong>hi</strong> there</p></div>',
      text: 'hi there',
    });
  });

  it('truncates oversized messages with a suffix', () => {
    const body = buildAgentMailEmailBody(
      'a'.repeat(AGENTMAIL_MAX_TEXT_LENGTH + 100),
    );

    expect(body.text.endsWith('[message truncated]')).toBe(true);
    expect(body.text.length).toBeLessThanOrEqual(AGENTMAIL_MAX_TEXT_LENGTH);
    expect(body.html.endsWith('[message truncated]</p></div>')).toBe(true);
  });
});
