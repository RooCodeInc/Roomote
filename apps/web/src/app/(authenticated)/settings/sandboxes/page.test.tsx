import { renderToStaticMarkup } from 'react-dom/server';

const { redirectMock, runtimeState } = vi.hoisted(() => ({
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  runtimeState: { cloudEnabled: false },
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

vi.mock('@/components/settings/pages/ComputeSettingsPage', () => ({
  ComputeSettingsPage: () => <div>Compute settings</div>,
}));

vi.mock('@/lib/server/env', () => ({
  Env: { R_CLOUD_ENABLED: 'cloud-setting' },
  isRoomoteCloudEnabled: () => runtimeState.cloudEnabled,
}));

import Page from './page';

describe('Sandbox settings page', () => {
  beforeEach(() => {
    runtimeState.cloudEnabled = false;
    redirectMock.mockClear();
  });

  it('renders self-hosted sandbox settings without authorizing again', () => {
    expect(renderToStaticMarkup(<Page />)).toContain('Compute settings');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('keeps cloud deployments redirected to personal settings', () => {
    runtimeState.cloudEnabled = true;

    expect(() => Page()).toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/settings/personal');
  });
});
