import { render, screen } from '@testing-library/react';

vi.mock('@/components/settings/pages/EnvironmentsSettingsPage', () => ({
  EnvironmentsSettingsPage: () => <div>Environments Page</div>,
}));

vi.mock('@/components/settings/pages/PersonalSettingsPage', () => ({
  PersonalSettingsPage: () => <div>Personal Settings Page</div>,
}));

vi.mock('@/lib/server/auth-context', () => ({
  authorizeOrThrow: vi.fn(async () => ({
    userId: 'user-1',
    primaryEmail: 'test@example.com',
    name: 'Test User',
    resource: { imageUrl: null },
  })),
}));

vi.mock('@/lib/server', () => ({
  userHasCredentialAccount: vi.fn(async () => true),
}));

import Page from './page';

describe('/settings', () => {
  it('shows the personal page', async () => {
    render(await Page());

    expect(screen.getByText('Personal Settings Page')).toBeInTheDocument();
    expect(screen.queryByText('Environments Page')).not.toBeInTheDocument();
  });
});
