import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/useHomeComposerSuggestions', () => ({
  useHomeComposerSuggestions: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { HomeComposerSuggestionsExperimentalSetting } from './HomeComposerSuggestionsExperimentalSetting';

describe('HomeComposerSuggestionsExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('is off by default and enables personalized Home suggestions', () => {
    render(<HomeComposerSuggestionsExperimentalSetting />);
    const toggle = screen.getByRole('switch', {
      name: 'Toggle Home suggestions',
    });

    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
  });

  it('disables the toggle while preferences load or update', () => {
    state.isLoading = true;

    render(<HomeComposerSuggestionsExperimentalSetting />);

    expect(
      screen.getByRole('switch', { name: 'Toggle Home suggestions' }),
    ).toBeDisabled();
  });
});
