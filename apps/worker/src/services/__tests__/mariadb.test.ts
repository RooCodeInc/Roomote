import { execa } from 'execa';
import type { CommandExecutor } from '../../command-executor';

import { createMariadbService } from '../mariadb';

vi.mock('execa', () => ({ execa: vi.fn() }));

describe('MariaDB running-instance preservation', () => {
  const service = createMariadbService('10');
  const execute = vi.fn();
  const executor = { execute } as unknown as CommandExecutor;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reuses a matching live instance without stopping it or removing its socket', async () => {
    execute.mockResolvedValue({ stdout: '23306\t/data/services/mysql/\n' });
    await service.start(executor, 23306);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Check running MariaDB instance',
        continue_on_error: false,
      }),
    );
  });

  it.each(['3306\t/data/services/mysql/\n', '23306\t/other/database/\n'])(
    'rejects a mismatched live instance without changing it: %s',
    async (stdout) => {
      execute.mockResolvedValue({ stdout });
      await expect(service.start(executor, 23306)).rejects.toThrow(
        'different MariaDB instance',
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it('propagates an unreadable live identity before destructive startup commands', async () => {
    execute.mockRejectedValue(new Error('Access denied'));
    await expect(service.start(executor, 23306)).rejects.toThrow(
      'Access denied',
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retains fresh startup when no server is listening on the socket', async () => {
    execute.mockResolvedValue({ stdout: '' });
    await service.start(executor, 23306);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Start MariaDB' }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Create root user for remote connections',
      }),
    );
  });

  it('requires the requested port and managed data directory for health and ownership', async () => {
    const mock = vi.mocked(execa);
    mock.mockResolvedValue({
      stdout: '23306\t/data/services/mysql/\n',
    } as never);
    expect(await service.healthCheck(23306)).toBe(true);
    expect(await service.verifyManagedInstance!(3306)).toBe(false);
    mock.mockResolvedValue({ stdout: '23306\t/other/database/\n' } as never);
    expect(await service.healthCheck(23306)).toBe(false);
    mock.mockRejectedValue(new Error('connection refused'));
    expect(await service.verifyManagedInstance!(23306)).toBe(false);
  });
});
