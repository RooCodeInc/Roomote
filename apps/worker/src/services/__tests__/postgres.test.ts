const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execMock }));

import { createPostgresService } from '../postgres';

describe('PostgreSQL managed instance verification', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'pg_isready') return { stdout: 'accepting connections' };
      if (command === 'sudo' && args[0] === 'head') {
        return {
          stdout: '123\n/data/services/postgres/data\n1700000000\n5432\n',
        };
      }
      if (command === 'sudo') return { stdout: 'server is running (PID: 123)' };
      return { stdout: 'S postgres -D /data/services/postgres/data' };
    });
  });

  it.each(['15', '16', '17'])(
    'accepts the live managed PostgreSQL %s port',
    async (version) => {
      expect(
        await createPostgresService(version).verifyManagedInstance!(5432),
      ).toBe(true);
    },
  );

  it('rejects a healthy unrelated port before treating the managed PID as its owner', async () => {
    expect(await createPostgresService('16').verifyManagedInstance!(5433)).toBe(
      false,
    );
    expect(execMock).not.toHaveBeenCalledWith(
      'ps',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects an incomplete postmaster file instead of inferring the port', async () => {
    execMock.mockImplementation(async (command: string) => ({
      stdout: command === 'pg_isready' ? '' : '123\n',
    }));
    expect(await createPostgresService('16').verifyManagedInstance!(5432)).toBe(
      false,
    );
  });

  it('still rejects a stale PID despite a matching port', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '123\ndata\ntime\n5432' })
      .mockResolvedValueOnce({ stdout: 'server is running (PID: 456)' });
    expect(await createPostgresService('16').verifyManagedInstance!(5432)).toBe(
      false,
    );
  });

  it('still rejects a zombie despite a matching PID and port', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '123\ndata\ntime\n5432' })
      .mockResolvedValueOnce({ stdout: 'server is running (PID: 123)' })
      .mockResolvedValueOnce({
        stdout: 'Z postgres -D /data/services/postgres/data',
      });
    expect(await createPostgresService('16').verifyManagedInstance!(5432)).toBe(
      false,
    );
  });
});
