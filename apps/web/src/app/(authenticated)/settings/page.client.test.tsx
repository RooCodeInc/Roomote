import { render, screen } from '@testing-library/react';

vi.mock('@/components/settings/pages/EnvironmentsSettingsPage', () => ({
  EnvironmentsSettingsPage: () => <div>Environments Page</div>,
}));

vi.mock('@/components/settings/pages/PersonalSettingsRoute', () => ({
  PersonalSettingsRoute: () => <div>Personal Settings Page</div>,
}));

import Page from './page';

describe('/settings', () => {
  it('shows the personal page', async () => {
    render(await Page());

    expect(screen.getByText('Personal Settings Page')).toBeInTheDocument();
    expect(screen.queryByText('Environments Page')).not.toBeInTheDocument();
  });
});
