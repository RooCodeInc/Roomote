import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  presets: undefined as unknown,
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
    {
      id: 'repository-judgement',
      label: 'Repository Judgement',
      description: 'Rules',
      sampleState: {},
      questions: {},
    },
  ],
  targets: {
    configured: { available: true, label: 'Jev via OpenRouter' },
    roomote: { available: true, label: 'Roomote judgment model' },
  },
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { presets?: boolean }) => ({
    data: options.presets ? state.presets : catalog,
    isPending: false,
  }),
  useMutation: () => ({
    isPending: false,
    data: state.data,
    reset: vi.fn(),
    mutateAsync: state.mutate,
  }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      judgment: {
        decisionCatalog: { queryOptions: () => ({}) },
        examplePresets: { queryOptions: () => ({ presets: true }) },
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
    state.mutate.mockImplementation(async () => state.data ?? {});
  });

  it('loads the sample state and asks the chosen models', async () => {
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

    await waitFor(() =>
      expect(state.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { email: { subject: 'Out of office' } },
          questions: catalog.decisions[0]!.questions,
          targets: ['configured', 'roomote'],
        }),
      ),
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

  it('shows each model’s answer and its latency', async () => {
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
    await waitFor(() => expect(screen.getByText(/212 ms/)).toBeInTheDocument());
    expect(screen.getByText(/Timed out/)).toBeInTheDocument();
    expect(screen.getByText('97%')).toBeInTheDocument();
  });
});

function selectOption(label: string, option: string) {
  fireEvent.pointerDown(screen.getByRole('combobox', { name: label }), {
    button: 0,
    pointerType: 'mouse',
  });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

it('loads exact packets and experimental questions, keeps labels out of requests, and preserves repeated results', async () => {
  const initial = {
    rule: 'Use lowercase session.',
    complete: true,
    evidence: [{ kind: 'patch', text: '+Session' }],
  };
  const expanded = {
    ...initial,
    evidence: [...initial.evidence, { kind: 'after', text: 'A Session' }],
  };
  const standard = {
    result: {
      type: 'choice',
      instructions: 'Judge the change',
      criteria: {
        pass: 'valid',
        violation: 'invalid',
        unclear: 'unknown',
        not_applicable: 'irrelevant',
      },
    },
  };
  const combined = {
    result: {
      ...standard.result,
      criteria: {
        pass: 'valid or irrelevant',
        violation: 'invalid',
        unclear: 'unknown',
      },
    },
  };
  state.presets = {
    examples: [
      {
        ruleId: 'wording',
        rule: initial.rule,
        name: 'Capitalization',
        expected: 'violation',
        threshold: 0.85,
        packets: [
          { state: initial, stage: 'initial', questionSet: 0 },
          { state: expanded, stage: 'expanded', questionSet: 0 },
        ],
      },
    ],
    questionSets: [{ standard, combined }],
  };
  state.mutate.mockResolvedValue({
    configured: {
      ok: true,
      provider: 'typesafe',
      model: 'jev',
      answers: {
        result: {
          type: 'choice',
          choice: 'violation',
          confidence: 0.82,
          probabilities: { violation: 0.9, pass: 0.08, unclear: 0.02 },
        },
      },
      invalid: [],
      latencyMs: 300,
    },
  });
  render(<JudgmentDecisionTesterPage />);
  selectOption('Decision', 'Repository Judgement');
  fireEvent.click(screen.getByRole('button', { name: 'Load example' }));
  expect(
    JSON.parse(
      (screen.getByLabelText('State (JSON)') as HTMLTextAreaElement).value,
    ),
  ).toEqual(initial);
  expect(
    JSON.parse(
      (screen.getByLabelText('Questions (JSON)') as HTMLTextAreaElement).value,
    ),
  ).toEqual(standard);
  selectOption('Evidence', '2 · expanded');
  selectOption('Question variant', 'Combined acceptable outcomes');
  fireEvent.click(screen.getByRole('button', { name: 'Load example' }));
  selectOption('Repetitions', 'Three runs');
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(3));
  for (const [input] of state.mutate.mock.calls) {
    expect(input).toEqual({
      state: expanded,
      questions: combined,
      targets: ['configured'],
    });
  }
  await waitFor(() =>
    expect(
      screen.getByText(/confidence 82%.*below threshold/),
    ).toBeInTheDocument(),
  );
  expect(screen.getByText('90%')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('State (JSON)'), {
    target: { value: '{"custom":true}' },
  });
  expect(screen.getByText(/Loaded:.*edited/)).toBeInTheDocument();
  // Results retain the original packet metadata after editing the next request.
  expect(
    screen.getByText(/Expected: violation · Threshold: 85% · expanded/),
  ).toBeInTheDocument();
  selectOption(
    'Recent runs',
    '3 · wording · Capitalization · combined · run 1',
  );
  expect(screen.getByText(/confidence 82%/)).toBeInTheDocument();
});
