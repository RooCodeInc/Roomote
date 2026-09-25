import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  data: undefined as unknown,
}));

const catalog = {
  decisions: [
    {
      id: 'agentmail-auto-reply',
      label: 'Automatic email reply',
      description: 'Whether inbound email is an automatic reply.',
      questions: {
        autoReply: {
          type: 'noul',
          instructions: 'Is `email` an automatic reply?',
        },
      },
      sampleState: { email: { subject: 'Out of office' } },
    },
  ],
  targets: {
    configured: { available: true, label: 'Jev via OpenRouter' },
    roomote: { available: true, label: 'Roomote judgment model' },
  },
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: catalog, isPending: false }),
  useMutation: () => ({
    isPending: false,
    data: state.data,
    reset: vi.fn(),
    mutate: state.mutate,
  }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      judgment: {
        decisionCatalog: { queryOptions: () => ({}) },
        testDecision: { mutationOptions: () => ({}) },
      },
    },
  }),
}));
vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { JudgmentDecisionTesterPage } from './JudgmentDecisionTesterPage';

beforeAll(() => {
  // Radix Select opens on pointer events jsdom does not implement.
  class MockPointerEvent extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? '';
    }
  }
  window.PointerEvent = MockPointerEvent as typeof PointerEvent;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

describe('JudgmentDecisionTesterPage', () => {
  beforeEach(() => {
    state.mutate.mockClear();
    state.data = undefined;
  });

  it('loads the sample state and asks the chosen models', () => {
    render(<JudgmentDecisionTesterPage />);
    expect(
      (screen.getByLabelText('State (JSON)') as HTMLTextAreaElement).value,
    ).toContain('Out of office');

    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Model' }), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(screen.getByRole('option', { name: 'Both, side by side' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { email: { subject: 'Out of office' } },
        questions: catalog.decisions[0]!.questions,
        targets: ['configured', 'roomote'],
      }),
      expect.anything(),
    );
  });

  it('refuses a state that is not JSON', () => {
    render(<JudgmentDecisionTesterPage />);
    fireEvent.change(screen.getByLabelText('State (JSON)'), {
      target: { value: '{nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByText(/State is not valid JSON/)).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('shows each model’s answer and its latency', () => {
    state.data = {
      configured: {
        ok: true,
        provider: 'openrouter',
        model: 'jev',
        answers: { autoReply: { type: 'noul', noul: 0.97 } },
        invalid: [],
        latencyMs: 212,
      },
      roomote: { ok: false, provider: 'roomote', error: 'timeout' },
    };
    render(<JudgmentDecisionTesterPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByText(/212 ms/)).toBeInTheDocument();
    expect(screen.getByText(/Timed out/)).toBeInTheDocument();
    expect(screen.getByText('97%')).toBeInTheDocument();
  });
});
