import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environmentVariables: {
      create: {
        mutationOptions: (options: object) => ({
          mutationFn: create,
          ...options,
        }),
      },
      list: { queryKey: () => ['environmentVariables.list'] },
    },
  }),
}));

import { CreateEnvVar } from './CreateEnvVar';

function setup() {
  const onCreated = vi.fn();
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreateEnvVar onCreated={onCreated} />
    </QueryClientProvider>,
  );
  const name = screen.getByLabelText('Name');
  const value = screen.getByLabelText('Value');
  fireEvent.change(name, { target: { value: 'FIRST_VARIABLE' } });
  fireEvent.change(value, { target: { value: 'first-value' } });
  return { name, value, form: name.closest('form')!, onCreated };
}

describe('CreateEnvVar pending edits', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['name', 'value'] as const)(
    'retains a newer %s after the first creation completes',
    async (field) => {
      let finish!: () => void;
      create.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const fields = setup();
      fireEvent.submit(fields.form);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const next = field === 'name' ? 'NEXT_VARIABLE' : 'newer-value';
      fireEvent.change(fields[field], { target: { value: next } });
      await act(async () => finish());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(),
      );
      expect(fields[field]).toHaveValue(next);
      expect(fields.onCreated).not.toHaveBeenCalled();
      if (field === 'name') {
        create.mockResolvedValueOnce(undefined);
        fireEvent.submit(fields.form);
        await waitFor(() => expect(fields.onCreated).toHaveBeenCalledOnce());
        expect(create).toHaveBeenLastCalledWith(
          { name: 'NEXT_VARIABLE', value: 'first-value' },
          expect.anything(),
        );
      }
    },
  );

  it('clears and closes after an unchanged successful creation', async () => {
    create.mockResolvedValueOnce(undefined);
    const fields = setup();
    fireEvent.submit(fields.form);
    await waitFor(() => expect(fields.onCreated).toHaveBeenCalledOnce());
    expect(fields.name).toHaveValue('');
    expect(fields.value).toHaveValue('');
  });

  it('keeps both inputs after a failed creation', async () => {
    create.mockRejectedValueOnce(new Error('Variable already exists'));
    const fields = setup();
    fireEvent.submit(fields.form);
    expect(await screen.findByText('Variable already exists')).toBeVisible();
    expect(fields.name).toHaveValue('FIRST_VARIABLE');
    expect(fields.value).toHaveValue('first-value');
    expect(fields.onCreated).not.toHaveBeenCalled();
  });

  it('does not submit another creation while pending', async () => {
    let finish!: () => void;
    create.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const fields = setup();
    fireEvent.submit(fields.form);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Creating...' }),
      ).toBeDisabled(),
    );
    fireEvent.change(fields.name, { target: { value: 'NEXT_VARIABLE' } });
    await act(async () => fireEvent.submit(fields.form));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
