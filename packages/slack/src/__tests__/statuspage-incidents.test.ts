const { getRedisMock, redis, env } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  env: {
    R_STATUSPAGE_INCIDENTS_URL:
      'https://roomote.statuspage.io/api/v2/incidents/unresolved.json' as
        | string
        | undefined,
  },
}));

vi.mock('@roomote/env', () => ({ Env: env }));
vi.mock('@roomote/redis', () => ({ getRedis: getRedisMock }));

import {
  buildStatuspageSlackWarning,
  getStatuspageIncident,
  isStatuspageIncidentsEnabled,
  selectStatuspageIncident,
} from '../statuspage-incidents';

const criticalIncident = {
  id: 'critical',
  name: 'API outage',
  status: 'investigating',
  impact: 'critical' as const,
  created_at: '2026-01-02T00:00:00Z',
  shortlink: 'https://stspg.io/critical',
  url: 'https://roomote.statuspage.io/incidents/critical',
};

describe('Statuspage incidents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.R_STATUSPAGE_INCIDENTS_URL =
      'https://roomote.statuspage.io/api/v2/incidents/unresolved.json';
    getRedisMock.mockReturnValue(redis);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('does not touch Redis or Statuspage when the deployment gate is disabled', async () => {
    env.R_STATUSPAGE_INCIDENTS_URL = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatuspageIncident()).resolves.toBeNull();

    expect(getRedisMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enables incident checks when the feed URL is configured', () => {
    expect(isStatuspageIncidentsEnabled()).toBe(true);
  });

  it('fetches incidents from the configured feed URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        incidents: [criticalIncident],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatuspageIncident()).resolves.toEqual(criticalIncident);

    expect(fetchMock).toHaveBeenCalledWith(env.R_STATUSPAGE_INCIDENTS_URL);
  });

  it('selects the highest-impact incident, then the newest incident', () => {
    expect(
      selectStatuspageIncident([
        {
          ...criticalIncident,
          id: 'older',
          created_at: '2026-01-01T00:00:00Z',
        },
        { ...criticalIncident, id: 'newer' },
        { ...criticalIncident, id: 'major', impact: 'major' },
      ]),
    ).toMatchObject({ id: 'newer' });
  });

  it('uses a fresh cached incident without fetching', async () => {
    redis.get.mockResolvedValueOnce(
      JSON.stringify({ incident: criticalIncident, fetchedAt: Date.now() }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatuspageIncident()).resolves.toEqual(criticalIncident);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to stale data when refreshing Statuspage fails', async () => {
    redis.get
      .mockResolvedValueOnce(
        JSON.stringify({
          incident: criticalIncident,
          fetchedAt: Date.now() - 5 * 60 * 1000,
        }),
      )
      .mockResolvedValueOnce(null);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(getStatuspageIncident()).resolves.toEqual(criticalIncident);
  });

  it('honors the negative cache without fetching', async () => {
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatuspageIncident()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns stale data while another process holds the refresh lock', async () => {
    redis.get
      .mockResolvedValueOnce(
        JSON.stringify({
          incident: criticalIncident,
          fetchedAt: Date.now() - 5 * 60 * 1000,
        }),
      )
      .mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatuspageIncident()).resolves.toEqual(criticalIncident);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats the exact Slack warning with the incident link', () => {
    expect(buildStatuspageSlackWarning(criticalIncident)).toBe(
      '> :warning: Heads up: my humans are <https://stspg.io/critical|working on an issue> that may affect me.',
    );
  });
});
