import { execa } from 'execa';
import type { Command } from '@roomote/types';
import type { CommandExecutor } from '../../command-executor';
import { createClickhouseService } from '../clickhouse';

vi.mock('execa', () => ({ execa: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it('starts and waits on the configured native port while retaining the HTTP port', async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  await createClickhouseService().start(
    { execute } as unknown as CommandExecutor,
    19001,
  );
  const commands = execute.mock.calls.map(([command]) => command as Command);
  expect(
    commands.find((command) => command.name === 'Configure ClickHouse')?.run,
  ).toContain('<tcp_port>19001</tcp_port>');
  expect(
    commands.find((command) => command.name === 'Configure ClickHouse')?.run,
  ).toContain('<http_port>8123</http_port>');
  expect(
    commands.find(
      (command) => command.name === 'Wait for ClickHouse to be ready',
    )?.run,
  ).toContain('client --port 19001');
});

it('checks the requested native endpoint rather than an unrelated default listener', async () => {
  vi.mocked(execa).mockResolvedValueOnce({} as never);
  expect(await createClickhouseService().healthCheck(19001)).toBe(true);
  expect(execa).toHaveBeenCalledWith(
    '/data/services/clickhouse/clickhouse',
    [
      'client',
      '--port',
      '19001',
      '--password',
      'password',
      '--query',
      'SELECT 1',
    ],
    { timeout: 5000 },
  );
  vi.mocked(execa).mockRejectedValueOnce(new Error('Connection refused'));
  expect(await createClickhouseService().healthCheck(19002)).toBe(false);
});
