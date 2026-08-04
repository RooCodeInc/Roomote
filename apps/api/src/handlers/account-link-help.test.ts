const { getHelpTextMock, warnMock } = vi.hoisted(() => ({
  getHelpTextMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentAccountLinkHelpText: getHelpTextMock,
}));

vi.mock('../logging.js', () => ({
  apiLogger: { warn: warnMock },
}));

import { appendAccountLinkHelpText } from './account-link-help';

describe('appendAccountLinkHelpText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends configured deployment help', async () => {
    getHelpTextMock.mockResolvedValue('Ask an admin for an invite.');

    await expect(appendAccountLinkHelpText('Link your account.')).resolves.toBe(
      'Link your account. Ask an admin for an invite.',
    );
  });

  it('preserves the base message when help is unset or unavailable', async () => {
    getHelpTextMock.mockResolvedValueOnce(null);
    await expect(appendAccountLinkHelpText('Link your account.')).resolves.toBe(
      'Link your account.',
    );

    getHelpTextMock.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(appendAccountLinkHelpText('Link your account.')).resolves.toBe(
      'Link your account.',
    );
    expect(warnMock).toHaveBeenCalledOnce();
  });
});
