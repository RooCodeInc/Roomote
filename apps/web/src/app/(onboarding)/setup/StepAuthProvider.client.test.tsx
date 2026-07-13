import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  BrandIcon: ({
    name,
    ...props
  }: { icon: string; name: string } & SVGProps<SVGSVGElement>) => (
    <svg aria-label={name} {...props} />
  ),
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepAuthProvider } from './StepAuthProvider';

describe('StepAuthProvider', () => {
  it('does not offer Telegram in the auth provider chooser', () => {
    const onContinue = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} />);

    expect(
      screen.queryByRole('button', { name: /telegram/i }),
    ).not.toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('offers Telegram in the signed-in communication provider chooser', () => {
    const onContinue = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} includeTelegram={true} />);

    fireEvent.click(screen.getByRole('button', { name: /telegram/i }));

    expect(onContinue).toHaveBeenCalledWith('telegram');
  });

  it('continues when clicking Slack', () => {
    const onContinue = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: /slack/i }));

    expect(onContinue).toHaveBeenCalledWith('slack');
  });

  it('shows a subtle skip link when onSkip is provided', () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('hides the skip link when onSkip is not provided', () => {
    render(<StepAuthProvider onContinue={vi.fn()} />);

    expect(
      screen.queryByRole('button', { name: 'Do this later' }),
    ).not.toBeInTheDocument();
  });
});
