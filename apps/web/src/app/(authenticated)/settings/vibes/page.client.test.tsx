vi.mock('@/components/settings/pages/VibesSettingsPage', () => ({
  VibesSettingsPage: () => <div>Vibes Settings Page</div>,
}));

import Page from './page';
import { render, screen } from '@testing-library/react';

describe('settings vibes page', () => {
  it('renders the vibes settings page wrapper', () => {
    render(<Page />);

    expect(screen.getByText('Vibes Settings Page')).toBeInTheDocument();
  });
});
