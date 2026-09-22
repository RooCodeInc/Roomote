import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      chooseTrialInference: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
      status: {
        queryKey: () => ['setupNew.status'],
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useMutation: vi.fn(),
    useQueryClient: vi.fn(),
  };
});

vi.mock('lucide-react', () => ({
  Gift: (props: SVGProps<SVGSVGElement>) => (
    <svg data-testid="gift" {...props} />
  ),
  Plug: (props: SVGProps<SVGSVGElement>) => (
    <svg data-testid="plug" {...props} />
  ),
}));

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    size?: string;
    variant?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

vi.mock('./SetupFooter', () => ({
  SetupFooter: ({ onBack }: { onBack?: () => void }) =>
    onBack ? (
      <button type="button" onClick={onBack}>
        Back
      </button>
    ) : null,
}));

const mockUseMutation = vi.mocked(useMutation);
const mockUseQueryClient = vi.mocked(useQueryClient);

import { StepConfigureInference } from './StepConfigureInference';

describe('StepConfigureInference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    } as unknown as ReturnType<typeof useMutation>);
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  it('renders the trial and custom choices with the requested copy', () => {
    render(
      <StepConfigureInference
        cloudEnabled
        onUseTrial={vi.fn()}
        onConfigureProvider={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Configure inference' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Choose a provider for task inference/),
    ).toHaveTextContent(
      'Choose a provider for task inference, the model Roomote uses to work on your tasks.Your Roomote Cloud trial includes $5 of inference, or you can configure your own provider directly.',
    );
    expect(
      screen.getByText(/Managed Roomote Cloud uses Kev/),
    ).toHaveTextContent(
      'Task inference is separate from judgment. Managed Roomote Cloud uses Kev, a hosted judgment model for fast routing and triage, by default unless you configure another judgment model. Its endpoint does not retain decision text. Connect TypeSafe, OpenRouter, or Vercel AI Gateway in Settings > Models to choose a different route.',
    );
    expect(
      screen.getByRole('button', {
        name: 'Use Roomote trial for task inference',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Use my own task-inference provider',
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('gift')).toBeInTheDocument();
    expect(screen.getByTestId('plug')).toBeInTheDocument();
  });

  it('starts trial inference and advances after the setup mutation succeeds', async () => {
    const onUseTrial = vi.fn();
    render(
      <StepConfigureInference
        cloudEnabled={false}
        onUseTrial={onUseTrial}
        onConfigureProvider={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use Roomote trial for task inference',
      }),
    );

    expect(mutateMock).toHaveBeenCalledOnce();

    const options = mockUseMutation.mock.calls[0]?.[0] as
      | { onSuccess?: () => Promise<void> | void }
      | undefined;
    await options?.onSuccess?.();
    expect(onUseTrial).toHaveBeenCalledOnce();
  });

  it('opens custom provider configuration without mutating trial state', () => {
    const onConfigureProvider = vi.fn();
    render(
      <StepConfigureInference
        cloudEnabled={false}
        onUseTrial={vi.fn()}
        onConfigureProvider={onConfigureProvider}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use my own task-inference provider',
      }),
    );

    expect(onConfigureProvider).toHaveBeenCalledOnce();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('returns to the preceding setup step', () => {
    const onBack = vi.fn();
    render(
      <StepConfigureInference
        cloudEnabled={false}
        onUseTrial={vi.fn()}
        onConfigureProvider={vi.fn()}
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledOnce();
  });
});
