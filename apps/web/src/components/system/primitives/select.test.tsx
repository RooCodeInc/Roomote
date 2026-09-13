import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';

import {
  Select,
  SelectContent,
  type SelectHandoffTarget,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

beforeAll(() => {
  class MockPointerEvent extends MouseEvent {
    pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? '';
    }
  }

  window.PointerEvent = MockPointerEvent as typeof PointerEvent;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
});

function visibleRef<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: React.RefObject<T | null>,
) {
  return (node: T | null) => {
    ref.current = node;
    if (node) {
      node.getClientRects = () =>
        [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
    }
  };
}

function TestSelect({
  targetProps,
  optIn = true,
  selectedValue,
  preventCloseAutoFocus = false,
}: {
  targetProps?: React.InputHTMLAttributes<HTMLInputElement>;
  optIn?: boolean;
  selectedValue?: string;
  preventCloseAutoFocus?: boolean;
}) {
  const targetRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Select
        defaultOpen
        defaultValue={selectedValue}
        handoffTargetOnSelect={optIn ? targetRef : undefined}
      >
        <SelectTrigger aria-label="Fruit">
          <SelectValue placeholder="Pick a fruit" />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={
            preventCloseAutoFocus
              ? (event) => event.preventDefault()
              : undefined
          }
        >
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
        </SelectContent>
      </Select>
      <input
        aria-label="Details"
        {...targetProps}
        ref={visibleRef(targetRef)}
      />
    </>
  );
}

async function flushCloseAutoFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Select focus handoff', () => {
  it('focuses the explicit text field after a pointer selection closes', async () => {
    render(<TestSelect />);

    const option = screen.getByRole('option', { name: 'Banana' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.pointerUp(option, { pointerType: 'mouse' });
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Details')).toHaveFocus();
  });

  it('focuses after keyboard selection, including selecting the current value', async () => {
    render(<TestSelect selectedValue="apple" />);

    fireEvent.keyDown(screen.getByRole('option', { name: 'Apple' }), {
      key: 'Enter',
    });
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Details')).toHaveFocus();
  });

  it('waits for a conditionally mounted controlled destination', async () => {
    function ConditionalExample() {
      const [value, setValue] = useState('apple');
      const targetRef = useRef<HTMLInputElement>(null);

      return (
        <>
          <Select
            defaultOpen
            value={value}
            onValueChange={setValue}
            handoffTargetOnSelect={targetRef}
          >
            <SelectTrigger aria-label="Fruit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple">Apple</SelectItem>
              <SelectItem value="banana">Banana</SelectItem>
            </SelectContent>
          </Select>
          {value === 'banana' ? (
            <input aria-label="Details" ref={visibleRef(targetRef)} />
          ) : null}
        </>
      );
    }

    render(<ConditionalExample />);
    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Details')).toHaveFocus();
  });

  it('restores focus to the trigger after Escape instead of handing off', async () => {
    render(<TestSelect />);

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await flushCloseAutoFocus();

    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveFocus();
  });

  it('restores focus to the trigger after outside dismissal', async () => {
    render(<TestSelect />);

    await flushCloseAutoFocus();
    fireEvent.pointerDown(document.body);
    await flushCloseAutoFocus();

    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveFocus();
  });

  it('preserves Radix trigger restoration when the Select has not opted in', async () => {
    render(<TestSelect optIn={false} />);

    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    await flushCloseAutoFocus();

    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveFocus();
  });

  it.each([
    ['disabled', { disabled: true }],
    ['read-only', { readOnly: true }],
    ['hidden', { hidden: true }],
    ['non-textual', { type: 'checkbox' }],
  ] as const)(
    'does not focus a %s destination',
    async (_label, targetProps) => {
      render(<TestSelect targetProps={targetProps} />);

      fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
      await flushCloseAutoFocus();

      expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveFocus();
    },
  );

  it('respects a close auto-focus handler that claims focus ownership', async () => {
    render(<TestSelect preventCloseAutoFocus />);

    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Details')).not.toHaveFocus();
  });

  it('does not retain a selection when controlled open state rejects closing', async () => {
    const onOpenChange = vi.fn();

    function ControlledOpenExample({ open }: { open: boolean }) {
      const targetRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <Select
            open={open}
            onOpenChange={onOpenChange}
            handoffTargetOnSelect={targetRef}
          >
            <SelectTrigger aria-label="Fruit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple">Apple</SelectItem>
            </SelectContent>
          </Select>
          <input aria-label="Details" ref={visibleRef(targetRef)} />
        </>
      );
    }

    const { rerender } = render(<ControlledOpenExample open />);
    fireEvent.click(screen.getByRole('option', { name: 'Apple' }));
    await act(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(resolve);
        }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    rerender(<ControlledOpenExample open={false} />);
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Details')).not.toHaveFocus();
  });

  it('focuses and opens an explicit downstream Select', async () => {
    function ChainedSelects() {
      const nextSelectRef = useRef<SelectHandoffTarget>(null);
      return (
        <>
          <Select defaultOpen handoffTargetOnSelect={nextSelectRef}>
            <SelectTrigger aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="discord">Discord</SelectItem>
            </SelectContent>
          </Select>
          <Select handoffRef={nextSelectRef}>
            <SelectTrigger aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updates">Updates</SelectItem>
            </SelectContent>
          </Select>
        </>
      );
    }

    render(<ChainedSelects />);
    fireEvent.click(screen.getByRole('option', { name: 'Discord' }));
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Channel')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Updates' })).toBeInTheDocument();
  });

  it('falls back to the source trigger when a downstream Select is disabled', async () => {
    function DisabledChain() {
      const nextSelectRef = useRef<SelectHandoffTarget>(null);
      return (
        <>
          <Select defaultOpen handoffTargetOnSelect={nextSelectRef}>
            <SelectTrigger aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="discord">Discord</SelectItem>
            </SelectContent>
          </Select>
          <Select disabled handoffRef={nextSelectRef}>
            <SelectTrigger aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updates">Updates</SelectItem>
            </SelectContent>
          </Select>
        </>
      );
    }

    render(<DisabledChain />);
    fireEvent.click(screen.getByRole('option', { name: 'Discord' }));
    await flushCloseAutoFocus();

    expect(screen.getByLabelText('Provider')).toHaveFocus();
    expect(screen.getByLabelText('Channel')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('does not hand off when selection is cancelled', async () => {
    const targetRef = {
      current: null,
    } as React.RefObject<HTMLInputElement | null>;
    render(
      <>
        <Select defaultOpen handoffTargetOnSelect={targetRef}>
          <SelectTrigger aria-label="Fruit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value="apple"
              onClick={(event) => event.preventDefault()}
            >
              Apple
            </SelectItem>
          </SelectContent>
        </Select>
        <input aria-label="Details" ref={visibleRef(targetRef)} />
      </>,
    );

    fireEvent.click(screen.getByRole('option', { name: 'Apple' }));
    await flushCloseAutoFocus();

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByLabelText('Details')).not.toHaveFocus();
  });
});
