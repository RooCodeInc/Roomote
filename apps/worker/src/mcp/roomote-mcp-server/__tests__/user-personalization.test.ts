const mocks = vi.hoisted(() => ({
  updatePersonalization: vi.fn(),
  getRoomoteConfig: vi.fn(),
}));

vi.mock('../tasks-api-client.js', () => ({
  updatePersonalization: mocks.updatePersonalization,
}));
vi.mock('../config.js', () => ({ getRoomoteConfig: mocks.getRoomoteConfig }));

import { handleUpdatePersonalization } from '../user-personalization';

describe('handleUpdatePersonalization', () => {
  beforeEach(() => {
    process.env.ROOMOTE_TASK_RUN_ID = '42';
    mocks.getRoomoteConfig.mockReturnValue({
      apiBaseUrl: 'https://roomote.test',
    });
    mocks.updatePersonalization.mockReset();
  });

  it('binds the update to the current run and returns no preference text', async () => {
    mocks.updatePersonalization.mockResolvedValue({ saved: true });

    const result = await handleUpdatePersonalization({
      preference: 'PRIVATE_SENTINEL',
      confidence: 'explicit',
    });

    expect(mocks.updatePersonalization).toHaveBeenCalledWith(
      expect.any(Object),
      42,
      { preference: 'PRIVATE_SENTINEL', confidence: 'explicit' },
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });

  it('fails closed when there is no trusted run', async () => {
    delete process.env.ROOMOTE_TASK_RUN_ID;

    const result = await handleUpdatePersonalization({
      preference: 'Be concise.',
      confidence: 'explicit',
    });

    expect(mocks.updatePersonalization).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"success":false'),
      }),
    ]);
  });
});
