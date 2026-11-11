import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const sandbox = vi.hoisted(() => ({
  query: vi.fn(),
  connected: true,
  client: null as unknown,
}));
vi.mock('./hooks/SandboxProvider', () => ({
  useSandboxClient: () => sandbox.client,
  useSandboxConnected: () => sandbox.connected,
}));
vi.mock('@/components/system', () => ({
  FileIcon: () => null,
  FolderIcon: () => null,
  Loader2Icon: () => <span role="status">Searching</span>,
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    onValueChange,
    ...props
  }: ComponentPropsWithoutRef<'input'> & {
    onValueChange: (value: string) => void;
  }) => (
    <input {...props} onChange={(event) => onValueChange(event.target.value)} />
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { FileSearch } from './FileSearch';

function deferred() {
  let resolve!: (value: {
    results: { path: string; name: string; type: 'file' }[];
  }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Parameters<typeof resolve>[0]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (name: string) => ({
  results: [
    { path: `src/${name}.ts`, name: `${name}.ts`, type: 'file' as const },
  ],
});

describe('FileSearch request freshness', () => {
  const onSelectFile = vi.fn();
  const onOpenChange = vi.fn();
  const view = (open = true) => (
    <FileSearch
      open={open}
      onOpenChange={onOpenChange}
      onSelectFile={onSelectFile}
    />
  );
  const change = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText('Search files...'), {
      target: { value },
    });
  const dispatch = async (value: string) => {
    change(value);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sandbox.query.mockReset();
    sandbox.client = { commands: { searchFiles: { query: sandbox.query } } };
    sandbox.connected = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores a pending result after the input is cleared', async () => {
    const old = deferred();
    sandbox.query.mockReturnValueOnce(old.promise);
    render(view());
    await dispatch('alpha');
    expect(sandbox.query).toHaveBeenCalledWith({
      query: 'alpha',
      maxResults: 20,
    });
    change('');
    await act(async () => old.resolve(result('alpha')));
    expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('removes old selectable options immediately and preserves normal selection', async () => {
    sandbox.query
      .mockResolvedValueOnce(result('alpha'))
      .mockResolvedValueOnce(result('beta'));
    render(view());
    await dispatch('alpha');
    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    change('beta');
    expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    fireEvent.click(screen.getByText('beta.ts'));
    expect(onSelectFile).toHaveBeenCalledWith('src/beta.ts');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(['success', 'failure'])(
    'does not let old %s replace the latest results',
    async (outcome) => {
      const old = deferred();
      sandbox.query
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(result('beta'));
      render(view());
      await dispatch('alpha');
      await dispatch('beta');
      await act(async () =>
        outcome === 'success'
          ? old.resolve(result('alpha'))
          : old.reject(new Error('late failure')),
      );
      expect(screen.getByText('beta.ts')).toBeInTheDocument();
      expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
    },
  );

  it('keeps the latest loading state when an older request completes', async () => {
    const old = deferred();
    const latest = deferred();
    sandbox.query
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    render(view());
    await dispatch('alpha');
    await dispatch('beta');
    await act(async () => old.resolve(result('alpha')));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
    await act(async () => latest.resolve(result('beta')));
    expect(screen.getByText('beta.ts')).toBeInTheDocument();
  });

  it('cancels queued searches on close and ignores results from a previous opening', async () => {
    const old = deferred();
    sandbox.query.mockReturnValueOnce(old.promise);
    const rendered = render(view());
    change('queued');
    rendered.rerender(view(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(sandbox.query).not.toHaveBeenCalled();
    rendered.rerender(view());
    await dispatch('alpha');
    rendered.rerender(view(false));
    rendered.rerender(view());
    await act(async () => old.resolve(result('alpha')));
    expect(screen.getByPlaceholderText('Search files...')).toHaveValue('');
    expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
  });

  it.each(['disconnect', 'client', 'unmount'])(
    'invalidates old work on %s',
    async (changeKind) => {
      const old = deferred();
      sandbox.query.mockReturnValueOnce(old.promise);
      const rendered = render(view());
      await dispatch('alpha');
      if (changeKind === 'unmount') rendered.unmount();
      else {
        if (changeKind === 'disconnect') sandbox.connected = false;
        else sandbox.client = { commands: { searchFiles: { query: vi.fn() } } };
        rendered.rerender(view());
      }
      await act(async () => old.resolve(result('alpha')));
      expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();
    },
  );
});
