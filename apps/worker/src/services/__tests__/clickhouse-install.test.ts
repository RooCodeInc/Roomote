import type { Command } from '@roomote/types';
import type { CommandExecutor } from '../../command-executor';
import { createClickhouseService } from '../clickhouse';

it('finishes materializing the fresh binary before installation completes', async () => {
  let completeVerification!: () => void;
  const verification = new Promise<void>((resolve) => {
    completeVerification = resolve;
  });
  const execute = vi.fn(async (command: Command) => {
    if (command.name === 'Check installed ClickHouse version')
      return { stdout: 'not_installed' };
    if (command.name === 'Verify downloaded ClickHouse binary')
      await verification;
    return { stdout: '' };
  });
  let installed = false;
  const install = createClickhouseService()
    .install({ execute } as unknown as CommandExecutor)
    .then(() => {
      installed = true;
    });
  await vi.waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Verify downloaded ClickHouse binary',
        continue_on_error: false,
      }),
    ),
  );
  expect(installed).toBe(false);
  completeVerification();
  await install;
  expect(installed).toBe(true);
});

it('fails installation when the downloaded executable cannot be verified', async () => {
  const execute = vi.fn(async (command: Command) => {
    if (command.name === 'Check installed ClickHouse version')
      return { stdout: 'not_installed' };
    if (command.name === 'Verify downloaded ClickHouse binary')
      throw new Error('decompression failed');
    return { stdout: '' };
  });
  await expect(
    createClickhouseService().install({
      execute,
    } as unknown as CommandExecutor),
  ).rejects.toThrow('decompression failed');
});

it('reuses an installed executable without downloading or verifying it again', async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ stdout: 'ClickHouse client version 26.11' });
  await createClickhouseService().install({
    execute,
  } as unknown as CommandExecutor);
  expect(execute).toHaveBeenCalledTimes(1);
});
