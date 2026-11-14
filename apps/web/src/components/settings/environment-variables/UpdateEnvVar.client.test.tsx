import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environmentVariables: {
      update: {
        mutationOptions: (options: object) => ({
          mutationFn: update,
          ...options,
        }),
      },
      list: { queryKey: () => ['environmentVariables.list'] },
    },
  }),
}));

import { UpdateEnvVar } from './UpdateEnvVar';

function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const onUpdated = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <UpdateEnvVar
        envVar={{
          id: 'variable-1',
          name: 'TEST_VARIABLE',
          userId: null,
          createdByUserId: null,
          lastUpdatedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
        onUpdated={onUpdated}
      />
    </QueryClientProvider>,
  );
  const input = screen.getByLabelText('New Value');
  const form = input.closest('form')!;
  return { input, form, onUpdated };
}

describe('UpdateEnvVar pending edits', () => {
  beforeEach(() => vi.resetAllMocks());

  it('keeps a newer value after the earlier update completes, then saves that value', async () => {
    let finish!: () => void;
    update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    update.mockResolvedValueOnce(undefined);
    const { input, form, onUpdated } = setup();
    fireEvent.change(input, { target: { value: 'submitted-value' } });
    fireEvent.submit(form);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'newer-value' } });
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled(),
    );
    expect(input).toHaveValue('newer-value');
    expect(onUpdated).not.toHaveBeenCalled();
    fireEvent.submit(form);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(update).toHaveBeenLastCalledWith(
      { id: 'variable-1', value: 'newer-value' },
      expect.anything(),
    );
  });

  it('clears and closes after an unchanged successful update', async () => {
    update.mockResolvedValueOnce(undefined);
    const { input, form, onUpdated } = setup();
    fireEvent.change(input, { target: { value: 'submitted-value' } });
    fireEvent.submit(form);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(input).toHaveValue('');
  });

  it('retains the value and error when an update fails', async () => {
    update.mockRejectedValueOnce(new Error('Update failed'));
    const { input, form, onUpdated } = setup();
    fireEvent.change(input, { target: { value: 'submitted-value' } });
    fireEvent.submit(form);
    expect(await screen.findByText('Update failed')).toBeVisible();
    expect(input).toHaveValue('submitted-value');
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('does not submit again while the first update is pending', async () => {
    let finish!: () => void;
    update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { input, form } = setup();
    fireEvent.change(input, { target: { value: 'submitted-value' } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Updating...' }),
      ).toBeDisabled(),
    );
    fireEvent.change(input, { target: { value: 'newer-value' } });
    await act(async () => fireEvent.submit(form));
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
