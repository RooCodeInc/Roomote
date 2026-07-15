import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
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

    render(
      <StepAuthProvider
        onContinue={onContinue}
        additionalProviders={['telegram', 'discord']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /telegram/i }));

    expect(onContinue).toHaveBeenCalledWith('telegram');
    expect(screen.getByRole('button', { name: /discord/i })).toBeVisible();
  });

  it('continues when clicking Slack', () => {
    const onContinue = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: /slack/i }));

    expect(onContinue).toHaveBeenCalledWith('slack');
  });

  it('disables the provider choices while a selection is being saved', () => {
    const onContinue = vi.fn();

    render(<StepAuthProvider onContinue={onContinue} disabled={true} />);

    const slackButton = screen.getByRole('button', { name: /slack/i });
    expect(slackButton).toBeDisabled();

    fireEvent.click(slackButton);

    expect(onContinue).not.toHaveBeenCalled();
  });

  it('disables Back and the skip link while a selection is being saved', () => {
    const onBack = vi.fn();
    const onSkip = vi.fn();

    render(
      <StepAuthProvider
        onContinue={vi.fn()}
        onBack={onBack}
        onSkip={onSkip}
        disabled={true}
      />,
    );

    const backButton = screen.getByRole('button', { name: /back/i });
    const skipButton = screen.getByRole('button', { name: 'Do this later' });

    expect(backButton).toBeDisabled();
    expect(skipButton).toBeDisabled();

    fireEvent.click(backButton);
    fireEvent.click(skipButton);

    expect(onBack).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
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
