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
  it('does not reserve collapsed header space for an invisible copy button', () => {
    render(
      <div className="group" data-state="open">
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
        </CodeBlock>
      </div>,
    );

    expect(
      screen.queryByRole('button', { name: 'Copy command' }),
    ).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /gh pr checks 1219/i });
    const command = screen.getByText(LONG_COMMAND);

    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(trigger).toHaveClass('group/collapsible-icon-trigger');
    expect(command).toHaveClass(
      'group-data-[state=closed]/collapsible-icon-trigger:truncate',
    );

    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Copy command' })).toBeVisible();
    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(command).toHaveClass(
      'group-data-[state=open]/collapsible-icon-trigger:break-words',
    );
  });
});
