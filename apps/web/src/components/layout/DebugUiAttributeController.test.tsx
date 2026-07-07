import { render } from '@testing-library/react';

const { debugUiState } = vi.hoisted(() => ({
  debugUiState: {
    isDebugUIVisible: false,
  },
}));

vi.mock('@/hooks/useShowDebugUI', () => ({
  useShowDebugUI: () => debugUiState,
}));

import { DebugUiAttributeController } from './DebugUiAttributeController';

describe('DebugUiAttributeController', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-debug-ui');
    debugUiState.isDebugUIVisible = false;
  });

  it('sets the document debug attribute when the flag and preference are both enabled', () => {
    debugUiState.isDebugUIVisible = true;

    render(<DebugUiAttributeController />);

    expect(document.documentElement.dataset.debugUi).toBe('true');
  });

  it('removes the document debug attribute when the preference is disabled', () => {
    document.documentElement.setAttribute('data-debug-ui', 'true');

    render(<DebugUiAttributeController />);

    expect(document.documentElement.hasAttribute('data-debug-ui')).toBe(false);
  });

  it('removes the document debug attribute when the feature flag is disabled', () => {
    render(<DebugUiAttributeController />);

    expect(document.documentElement.hasAttribute('data-debug-ui')).toBe(false);
  });
});
