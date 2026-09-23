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
      screen.getByText(/Your Roomote Cloud trial includes/),
    ).toHaveTextContent(
      'Your Roomote Cloud trial includes $5 of inference to try things out, or you can configure your own provider directly.',
    );
    expect(
      screen.getByText(/Some Roomote functionality uses fast judgement models/),
    ).toHaveTextContent(
      'Some Roomote functionality uses fast judgement models, not just LLMs. You can use the Roomote provider model for free, or configure your own (TypeSafe Jev, OpenRouter, Vercel).',
    );
    expect(
      screen.getByText('The Roomote provider never retains your data.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Use the Roomote provider',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Configure my own provider',
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
        name: 'Use the Roomote provider',
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
        name: 'Configure my own provider',
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
