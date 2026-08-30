import { fireEvent, render, screen } from '@testing-library/react';

import { Search } from '@/components/system';

import { Tool, ToolHeader } from './tool';

describe('ToolHeader', () => {
  it('shows running and failed states textually while success stays implied', () => {
    const { rerender } = render(
      <ToolHeader
        action="Using"
        object="Search"
        icon={Search}
        state="input-available"
        collapsible={false}
      />,
    );

    expect(screen.getByText('Running')).not.toHaveClass('sr-only');

    rerender(
      <ToolHeader
        action="Used"
        object="Search"
        icon={Search}
        state="output-available"
        collapsible={false}
      />,
    );
    expect(screen.getByText('Completed')).toHaveClass('sr-only');

    rerender(
      <ToolHeader
        action="Used"
        object="Search"
        icon={Search}
        state="output-error"
        collapsible={false}
      />,
    );
    expect(screen.getByText('Failed')).not.toHaveClass('sr-only');
  });

  it('exposes expansion state only for interactive headers', () => {
    const { rerender } = render(
      <Tool>
        <ToolHeader
          action="Used"
          object="Search"
          icon={Search}
          state="output-available"
        />
      </Tool>,
    );

    const trigger = screen.getByRole('button', {
      name: 'Used Search Completed',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <Tool>
        <ToolHeader
          action="Used"
          object="Search"
          icon={Search}
          state="output-available"
          collapsible={false}
        />
      </Tool>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps long action-only labels truncatable inside the header row', () => {
    const action =
      'Read /tmp/roomote-tool-header-regression-path-with-a-very-long-file-name.txt';

    render(
      <ToolHeader
        action={action}
        icon={Search}
        state="output-available"
        collapsible={false}
      />,
    );

    const actionLabel = screen.getByText(action);
    const labelRow = actionLabel.parentElement;

    expect(labelRow).not.toBeNull();
    expect(labelRow?.className).toContain('overflow-hidden');
    expect(actionLabel.className).toContain('min-w-0');
    expect(actionLabel.className).toContain('truncate');
    expect(actionLabel.className).not.toContain('shrink-0');
  });

  it('keeps long tool labels truncatable inside the header row', () => {
    render(
      <ToolHeader
        action="Used"
        object="Browser Capture Scroll Region With Extremely Long Named Debug Annotation For Mobile Layout Verification"
        suffix="Browser Automation Debug Server With An Excessively Long Name"
        icon={Search}
        state="output-available"
        collapsible={false}
      />,
    );

    const object = screen.getByText(
      'Browser Capture Scroll Region With Extremely Long Named Debug Annotation For Mobile Layout Verification',
    );
    const suffix = screen.getByText(
      'Browser Automation Debug Server With An Excessively Long Name',
    );
    const labelRow = screen.getByText('Used').parentElement;

    expect(labelRow).not.toBeNull();
    expect(labelRow?.className).toContain('overflow-hidden');
    expect(object.className).toContain('min-w-0');
    expect(object.className).toContain('truncate');
    expect(suffix.className).toContain('min-w-0');
    expect(suffix.className).toContain('truncate');
  });

  it('allows custom suffix prefixes for non-source labels', () => {
    render(
      <ToolHeader
        action="Explore"
        object="read"
        suffix="1m 26s"
        suffixPrefix="·"
        icon={Search}
        state="output-available"
        collapsible={false}
      />,
    );

    expect(screen.getByText('·')).toBeInTheDocument();
    expect(screen.queryByText('from')).not.toBeInTheDocument();
  });
});
