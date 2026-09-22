import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  settings: {
    mode: 'off' as 'off' | 'on',
    policy: '',
    model: { kind: 'judgment' } as
      | { kind: 'judgment' }
      | { kind: 'helper'; model: string }
      | null,
  },
  setAuto: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.settings }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: (options: { mutationFn: (input: unknown) => unknown }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      state.setAuto(input);
      return options.mutationFn(input);
    },
  }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    integrationToolPolicies: {
      getAuto: { queryOptions: () => ({}), queryKey: () => ['auto'] },
      setAuto: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: async (input: unknown) => input,
        }),
      },
    },
  }),
}));

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';

describe('IntegrationToolAutoModeSetting', () => {
  beforeEach(() => {
    state.settings = { mode: 'off', policy: '', model: { kind: 'judgment' } };
    state.setAuto.mockClear();
  });

  it('shows the current mode and that the hosted model is shadowing while off', () => {
    render(<IntegrationToolAutoModeSetting />);
    expect(screen.getByRole('radio', { name: /^Off/ })).toBeChecked();
    expect(
      screen.getByText(/assesses each call in the background/),
    ).toBeInTheDocument();
  });

  it('switches the mode and saves the guidance separately', async () => {
    render(<IntegrationToolAutoModeSetting />);
    fireEvent.click(screen.getByRole('radio', { name: /^On/ }));
    expect(state.setAuto).toHaveBeenLastCalledWith({ mode: 'on', policy: '' });

    const guidance = screen.getByLabelText('Approval guidance');
    expect(
      screen.getByRole('button', { name: 'Save guidance' }),
    ).toBeDisabled();
    fireEvent.change(guidance, { target: { value: 'Reads only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guidance' }));
    await waitFor(() =>
      expect(state.setAuto).toHaveBeenLastCalledWith({
        mode: 'off',
        policy: 'Reads only.',
      }),
    );
  });

  it('cannot be turned on without a hosted judgment model, and says why', () => {
    state.settings = {
      mode: 'off',
      policy: '',
      model: { kind: 'helper', model: 'openai/gpt-5.6-mini' },
    };
    render(<IntegrationToolAutoModeSetting />);
    expect(screen.getByRole('radio', { name: /^On/ })).toBeDisabled();
    expect(
      screen.getByText(/helper model \(openai\/gpt-5.6-mini\)/),
    ).toBeInTheDocument();

    state.settings = { mode: 'off', policy: '', model: null };
    render(<IntegrationToolAutoModeSetting />);
    expect(screen.getByText(/none is available/)).toBeInTheDocument();
  });
});
