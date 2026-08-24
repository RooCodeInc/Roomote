import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { mockCapture } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
}));

vi.mock('@/hooks/useTelemetry', () => ({
  useTelemetry: () => ({ capture: mockCapture }),
}));

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
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

import { StepEnvironmentExplainer } from './StepEnvironmentExplainer';

describe('StepEnvironmentExplainer', () => {
  beforeEach(() => {
    mockCapture.mockClear();
  });

  it('tracks and continues to repository selection', () => {
    const onContinue = vi.fn();

    render(<StepEnvironmentExplainer onContinue={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(mockCapture).toHaveBeenCalledWith(
      'activation_setup_environment_explained',
      { action: 'continue' },
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Skip' }),
    ).not.toBeInTheDocument();
  });
});
