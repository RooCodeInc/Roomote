import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/useFastSessionCommunicationJevExperiment', () => ({
  useFastSessionCommunicationJevExperiment: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { FastSessionCommunicationJevExperimentalSetting } from './FastSessionCommunicationJevExperimentalSetting';

describe('FastSessionCommunicationJevExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('renders the requested title and description while preserving the setting toggle', () => {
    render(<FastSessionCommunicationJevExperimentalSetting />);

    expect(
      screen.getByText('Real-time session/task communication'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Send all task activity to the parent session and let it use the decision model to determine when to take action.',
      ),
    ).toBeInTheDocument();

    const toggle = screen.getByRole('switch', {
      name: 'Toggle real-time session/task communication',
    });
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
  });
});
