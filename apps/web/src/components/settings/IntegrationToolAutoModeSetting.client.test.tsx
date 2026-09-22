import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  settings: {
    mode: 'shadow' as 'off' | 'shadow' | 'on',
    policy: '',
    model: { kind: 'helper', model: 'openai/gpt-5.6-mini' } as
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
    state.settings = {
      mode: 'shadow',
      policy: '',
      model: { kind: 'helper', model: 'openai/gpt-5.6-mini' },
    };
    state.setAuto.mockClear();
  });

  it('shows the current mode and which model Auto would consult', () => {
    render(<IntegrationToolAutoModeSetting />);
    expect(screen.getByRole('radio', { name: /Shadow/ })).toBeChecked();
    expect(
      screen.getByText(/helper model \(openai\/gpt-5.6-mini\)/),
    ).toBeInTheDocument();
  });

  it('switches the mode and saves the policy separately', async () => {
    render(<IntegrationToolAutoModeSetting />);
    fireEvent.click(screen.getByRole('radio', { name: /^On/ }));
    expect(state.setAuto).toHaveBeenLastCalledWith({ mode: 'on', policy: '' });

    const policy = screen.getByLabelText('Risk guidance');
    expect(
      screen.getByRole('button', { name: 'Save guidance' }),
    ).toBeDisabled();
    fireEvent.change(policy, { target: { value: 'Reads only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guidance' }));
    await waitFor(() =>
      expect(state.setAuto).toHaveBeenLastCalledWith({
        mode: 'shadow',
        policy: 'Reads only.',
      }),
    );
  });

  it('says so when no decision model is available', () => {
    state.settings = { mode: 'off', policy: '', model: null };
    render(<IntegrationToolAutoModeSetting />);
    expect(
      screen.getByText(/No decision model is available/),
    ).toBeInTheDocument();
  });
});
