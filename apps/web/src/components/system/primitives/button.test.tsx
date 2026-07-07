import { fireEvent, render, screen } from '@testing-library/react';

import { Button } from './button';

describe('Button', () => {
  it('disables the button when loading', () => {
    render(<Button loading>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders a spinner when loading', () => {
    render(<Button loading>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button.firstElementChild).toHaveClass('animate-spin');
  });

  it('stays disabled when loading is combined with disabled', () => {
    render(
      <Button loading disabled>
        Save
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders normally when loading is false', () => {
    render(<Button loading={false}>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).not.toBeDisabled();
    expect(button.querySelector('.animate-spin')).toBeNull();
  });

  it('preserves caller-provided onClickCapture handlers', () => {
    const handleClickCapture = vi.fn();

    render(
      <Button onClickCapture={handleClickCapture} type="button">
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(handleClickCapture).toHaveBeenCalledTimes(1);
  });

  it('renders a single child when using asChild', () => {
    render(
      <Button asChild>
        <a href="https://example.com/tasks">Tasks</a>
      </Button>,
    );

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'href',
      'https://example.com/tasks',
    );
  });

  it('rejects loading when using asChild', () => {
    expect(() =>
      render(
        // @ts-expect-error loading is not supported with asChild
        <Button asChild loading>
          <a href="https://example.com/tasks">Tasks</a>
        </Button>,
      ),
    ).toThrow(
      'Button does not support `loading` when `asChild` is true. Render a native button instead.',
    );
  });
});
