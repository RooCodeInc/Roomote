import { fireEvent, render, screen } from '@testing-library/react';

import {
  CodeBlock,
  CodeBlockCommand,
  CodeBlockHeader,
  CodeBlockTitle,
} from './code-block';

const LONG_COMMAND =
  'gh pr checks 1219 --repo Roomote/example-app --watch --required --interval 5 --json state,name,link';

describe('CodeBlock', () => {
  it('uses theme colors for compact output', () => {
    const { container } = render(
      <CodeBlock code="live output" language="bash" variant="compact" />,
    );

    const output = container.querySelector('[data-language="bash"] > div');

    expect(output).toHaveClass('bg-muted/50', 'text-foreground');
    expect(output).not.toHaveClass('bg-zinc-800', 'dark');
  });

  it('does not reserve collapsed header space for an invisible copy button', () => {
    render(
      <CodeBlock
        code="completed"
        language="bash"
        variant="compact"
        collapsible
        defaultCollapsed
        showCommandCopy
        command={LONG_COMMAND}
        highlight={false}
      >
        <CodeBlockHeader className="w-full">
          <CodeBlockTitle>
            <CodeBlockCommand highlight={false}>
              {LONG_COMMAND}
            </CodeBlockCommand>
          </CodeBlockTitle>
        </CodeBlockHeader>
      </CodeBlock>,
    );

    expect(
      screen.queryByRole('button', { name: 'Copy command' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /gh pr checks 1219/i }));

    expect(screen.getByRole('button', { name: 'Copy command' })).toBeVisible();
    expect(screen.getByText(LONG_COMMAND)).toHaveClass(
      'group-data-[state=open]:break-words',
    );
  });
});
