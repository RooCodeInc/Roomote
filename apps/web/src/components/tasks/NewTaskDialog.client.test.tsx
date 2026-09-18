import { act, fireEvent, render, screen } from '@testing-library/react';

const { onOpenChangeMock } = vi.hoisted(() => ({
  onOpenChangeMock: vi.fn(),
}));

vi.mock('./NewTaskForm', () => ({
  NewTaskForm: ({
    animate,
    onTaskStarted,
  }: {
    animate?: boolean;
    onTaskStarted: () => void;
  }) => (
    <button
      type="button"
      data-animate={String(animate)}
      data-testid="new-task-form"
      onClick={onTaskStarted}
    >
      Launch task
    </button>
  ),
}));

import { NewTaskDialog } from './NewTaskDialog';

class MockVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
}

describe('NewTaskDialog', () => {
  const originalVisualViewport = window.visualViewport;
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;
  let visualViewport: MockVisualViewport;

  beforeEach(() => {
    vi.clearAllMocks();
    visualViewport = new MockVisualViewport();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 844,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it('labels the dialog and renders the shared task form', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    const dialog = screen.getByRole('dialog', { name: 'New Session' });

    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('heading', { name: 'New Session' })).toHaveClass(
      'sr-only',
    );
    expect(
      screen.queryByText(/^Choose where Roomote should work/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('new-task-form')).toHaveAttribute(
      'data-animate',
      'false',
    );
  });

  it('closes after the shared form starts a task', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch task' }));

    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });

  it('keeps the mobile sheet inside the visual viewport as it resizes and scrolls', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    const dialog = screen.getByRole('dialog', { name: 'New Session' });

    expect(dialog).toHaveStyle({
      '--new-task-dialog-bottom': '0px',
      '--new-task-dialog-height': '844px',
    });

    act(() => {
      visualViewport.height = 430;
      visualViewport.dispatchEvent(new Event('resize'));
    });

    expect(dialog).toHaveStyle({
      '--new-task-dialog-bottom': '414px',
      '--new-task-dialog-height': '430px',
    });

    act(() => {
      visualViewport.height = 400;
      visualViewport.offsetTop = 30;
      visualViewport.dispatchEvent(new Event('scroll'));
    });

    expect(dialog).toHaveStyle({
      '--new-task-dialog-bottom': '414px',
      '--new-task-dialog-height': '400px',
    });
  });

  it('recomputes the mobile sheet after orientation changes and removes listeners on close', () => {
    const resizeSpy = vi.spyOn(visualViewport, 'removeEventListener');
    const { rerender } = render(
      <NewTaskDialog open onOpenChange={onOpenChangeMock} />,
    );

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 390,
    });
    visualViewport.height = 300;

    act(() => window.dispatchEvent(new Event('orientationchange')));

    expect(screen.getByRole('dialog', { name: 'New Session' })).toHaveStyle({
      '--new-task-dialog-bottom': '90px',
      '--new-task-dialog-height': '300px',
    });

    rerender(<NewTaskDialog open={false} onOpenChange={onOpenChangeMock} />);

    expect(resizeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(resizeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
