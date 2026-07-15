import type {
  ButtonHTMLAttributes,
  ChangeEvent,
  FocusEvent,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SVGProps,
  TextareaHTMLAttributes,
} from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  inputPropsById,
  textareaPropsById,
  mockSettingsState,
  mockUpdateVibesSettings,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  inputPropsById: {
    current: {} as Record<string, InputHTMLAttributes<HTMLInputElement>>,
  },
  textareaPropsById: {
    current: {} as Record<string, TextareaHTMLAttributes<HTMLTextAreaElement>>,
  },
  mockSettingsState: {
    current: {
      slackSummonEmoji: null as string | null,
      slackAckEmoji: 'eyes',
      slackCompletionEmoji: 'white_check_mark',
      slackPrClosedEmoji: 'x',
      styleGuidance: null as string | null,
      defaults: {
        slackAckEmoji: 'eyes',
        slackCompletionEmoji: 'white_check_mark',
        slackPrClosedEmoji: 'x',
      },
    },
  },
  mockUpdateVibesSettings: vi.fn(
    async (input: {
      slackSummonEmoji?: string | null;
      slackAckEmoji?: string;
      slackCompletionEmoji?: string;
      slackPrClosedEmoji?: string;
      styleGuidance?: string | null;
    }): Promise<
      | {
          success: true;
          settings: typeof mockSettingsState.current;
        }
      | {
          success: false;
          fieldErrors: Partial<
            Record<
              | 'slackAckEmoji'
              | 'slackCompletionEmoji'
              | 'slackPrClosedEmoji'
              | 'styleGuidance',
              string
            >
          >;
        }
    > => {
      const normalize = (value: string | null | undefined) => {
        const trimmed = value
          ?.trim()
          .replace(/^:+|:+$/g, '')
          .toLowerCase();
        return trimmed ? trimmed : null;
      };

      if (
        Object.prototype.hasOwnProperty.call(input, 'slackAckEmoji') &&
        !normalize(input.slackAckEmoji)
      ) {
        return {
          success: false as const,
          fieldErrors: {
            slackAckEmoji: 'Acknowledgement emoji is required.',
          },
        };
      }

      if (
        Object.prototype.hasOwnProperty.call(input, 'slackCompletionEmoji') &&
        !normalize(input.slackCompletionEmoji)
      ) {
        return {
          success: false as const,
          fieldErrors: {
            slackCompletionEmoji: 'Completion emoji is required.',
          },
        };
      }

      if (
        Object.prototype.hasOwnProperty.call(input, 'slackPrClosedEmoji') &&
        !normalize(input.slackPrClosedEmoji)
      ) {
        return {
          success: false as const,
          fieldErrors: {
            slackPrClosedEmoji: 'Closed PR emoji is required.',
          },
        };
      }

      mockSettingsState.current = {
        ...mockSettingsState.current,
        ...(Object.prototype.hasOwnProperty.call(input, 'slackSummonEmoji')
          ? { slackSummonEmoji: normalize(input.slackSummonEmoji) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'slackAckEmoji')
          ? { slackAckEmoji: normalize(input.slackAckEmoji) ?? 'eyes' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'slackCompletionEmoji')
          ? {
              slackCompletionEmoji:
                normalize(input.slackCompletionEmoji) ?? 'white_check_mark',
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'slackPrClosedEmoji')
          ? {
              slackPrClosedEmoji: normalize(input.slackPrClosedEmoji) ?? 'x',
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'styleGuidance')
          ? { styleGuidance: input.styleGuidance?.trim() || null }
          : {}),
      };

      return {
        success: true as const,
        settings: mockSettingsState.current,
      };
    },
  ),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    vibes: {
      get: {
        queryKey: () => ['vibes'],
        queryOptions: () => ({
          queryKey: ['vibes'],
          queryFn: async () => mockSettingsState.current,
        }),
      },
      update: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockUpdateVibesSettings,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('@/components/settings', () => ({
  Section: ({
    title,
    children,
    footer,
  }: {
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <div>{children}</div>
      {footer ? <div>{footer}</div> : null}
    </section>
  ),
}));

vi.mock('@/components/system', () => ({
  AlertCircle: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  MessageSquareHeart: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => {
    if (props.id) {
      inputPropsById.current[props.id] = props;
    }

    return <input {...props} />;
  },
  Label: ({
    children,
    ...props
  }: { children: ReactNode } & LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  RotateCcw: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Skeleton: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Smile: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Spinner: (props: HTMLAttributes<HTMLSpanElement>) => <span {...props} />,
  Sun: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => {
    if (props.id) {
      textareaPropsById.current[props.id] = props;
    }

    return <textarea {...props} />;
  },
  Trash2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

import { VibesSettings } from './VibesSettings';

function renderVibesSettings() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <VibesSettings />
    </QueryClientProvider>,
  );
}

async function renderLoadedVibesSettings() {
  renderVibesSettings();

  await waitFor(() => {
    expect(screen.getByLabelText('Emoji name')).toHaveValue(
      mockSettingsState.current.slackSummonEmoji ?? '',
    );
    expect(screen.getByLabelText('Acknowledgement')).toHaveValue(
      mockSettingsState.current.slackAckEmoji,
    );
    expect(screen.getByLabelText('Completion')).toHaveValue(
      mockSettingsState.current.slackCompletionEmoji,
    );
    expect(screen.getByLabelText('Closed PR')).toHaveValue(
      mockSettingsState.current.slackPrClosedEmoji,
    );
  });

  await waitFor(() => {
    expect(screen.getByLabelText('Custom style')).toHaveValue(
      mockSettingsState.current.styleGuidance ?? '',
    );
  });
}

function getInputProps(input: HTMLElement) {
  const inputId = (input as HTMLInputElement).id;
  const props = inputPropsById.current[inputId];

  if (!props) {
    throw new Error(`Missing mocked input props for ${inputId}`);
  }

  return props;
}

function getTextareaProps(textarea: HTMLElement) {
  const textareaId = (textarea as HTMLTextAreaElement).id;
  const props = textareaPropsById.current[textareaId];

  if (!props) {
    throw new Error(`Missing mocked textarea props for ${textareaId}`);
  }

  return props;
}

async function changeControlledInput(
  input: HTMLElement,
  value: string,
  expectedValue = value,
) {
  const props = getInputProps(input);

  await act(async () => {
    props.onChange?.({
      target: { value },
    } as ChangeEvent<HTMLInputElement>);
  });

  await waitFor(() => {
    expect(input).toHaveValue(expectedValue);
  });
}

async function blurControlledInput(input: HTMLElement) {
  const props = getInputProps(input);

  await act(async () => {
    props.onBlur?.({} as FocusEvent<HTMLInputElement>);
  });
}

async function changeControlledTextarea(
  textarea: HTMLElement,
  value: string,
  expectedValue = value,
) {
  const props = getTextareaProps(textarea);

  await act(async () => {
    props.onChange?.({
      target: { value },
    } as ChangeEvent<HTMLTextAreaElement>);
  });

  await waitFor(() => {
    expect(textarea).toHaveValue(expectedValue);
  });
}

describe('VibesSettings', () => {
  beforeEach(() => {
    vi.useRealTimers();
    inputPropsById.current = {};
    textareaPropsById.current = {};
    mockUpdateVibesSettings.mockClear();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    mockSettingsState.current = {
      slackSummonEmoji: null,
      slackAckEmoji: 'eyes',
      slackCompletionEmoji: 'white_check_mark',
      slackPrClosedEmoji: 'x',
      styleGuidance: null,
      defaults: {
        slackAckEmoji: 'eyes',
        slackCompletionEmoji: 'white_check_mark',
        slackPrClosedEmoji: 'x',
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-saves the summon emoji and normalizes colon-wrapped input', async () => {
    await renderLoadedVibesSettings();

    expect(screen.getByLabelText('Custom style')).toBeInTheDocument();

    const input = screen.getByLabelText('Emoji name');
    await changeControlledInput(input, ':ShipIt:', 'ShipIt');

    await waitFor(
      () => {
        expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
          slackSummonEmoji: 'ShipIt',
        });
      },
      { timeout: 2000 },
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Emoji name')).toHaveValue('shipit');
    });

    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Change summon emoji to :shipit:',
    );
  });

  it('renders the custom style textarea by default', async () => {
    mockSettingsState.current.styleGuidance = 'Keep it direct.';

    await renderLoadedVibesSettings();

    expect(screen.getByLabelText('Custom style')).toHaveValue(
      'Keep it direct.',
    );
    expect(screen.getByLabelText('Custom style')).toHaveAttribute(
      'maxlength',
      '400',
    );
  });

  it('saves custom style guidance with explicit Save and Reset controls', async () => {
    mockSettingsState.current.styleGuidance = 'Be concise.';

    await renderLoadedVibesSettings();

    const textarea = screen.getByLabelText('Custom style');
    await changeControlledTextarea(textarea, 'Be terse and calm.');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        styleGuidance: 'Be terse and calm.',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Custom style')).toHaveValue(
        'Be terse and calm.',
      );
    });

    expect(toastSuccessMock).toHaveBeenCalledWith('Style guidance saved.');

    await changeControlledTextarea(textarea, 'Temporary guidance');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Custom style')).toHaveValue(
        'Be terse and calm.',
      );
    });
  });

  it('shows the generic inline error for invalid custom style guidance', async () => {
    mockUpdateVibesSettings.mockResolvedValueOnce({
      success: false,
      fieldErrors: {
        styleGuidance: 'Please only enter tone of voice guidance here.',
      },
    });

    await renderLoadedVibesSettings();

    const textarea = screen.getByLabelText('Custom style');
    await changeControlledTextarea(
      textarea,
      'Be concise and always open a PR.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.getByText('Please only enter tone of voice guidance here.'),
      ).toBeInTheDocument();
    });
  });

  it('shows a character counter near the length limit for custom style guidance', async () => {
    await renderLoadedVibesSettings();

    const textarea = screen.getByLabelText('Custom style');
    await changeControlledTextarea(textarea, 'x'.repeat(361));

    expect(screen.getByText('361/400')).toBeInTheDocument();
  });

  it('applies the goblins and gremlins style preset', async () => {
    await renderLoadedVibesSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Goblin Mode' }));

    const textarea = screen.getByLabelText(
      'Custom style',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain('goblins and gremlins');
  });

  it('shows a required-field error when the acknowledgement emoji is blank on blur', async () => {
    await renderLoadedVibesSettings();

    const input = screen.getByLabelText('Acknowledgement');
    await changeControlledInput(input, '   ');
    await blurControlledInput(input);

    await waitFor(() => {
      expect(
        screen.getByText('Acknowledgement emoji is required.'),
      ).toBeInTheDocument();
    });
  });

  it('resets the acknowledgement emoji back to its default value', async () => {
    await renderLoadedVibesSettings();

    const input = screen.getByLabelText('Acknowledgement');
    await changeControlledInput(input, 'shipit');
    await blurControlledInput(input);

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackAckEmoji: 'shipit',
      });
    });

    fireEvent.click(screen.getByLabelText('Reset acknowledgement emoji'));

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackAckEmoji: 'eyes',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Acknowledgement')).toHaveValue('eyes');
    });
  });

  it('resets the closed PR emoji back to its default value', async () => {
    await renderLoadedVibesSettings();

    const input = screen.getByLabelText('Closed PR');
    await changeControlledInput(input, 'no_entry_sign');
    await blurControlledInput(input);

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackPrClosedEmoji: 'no_entry_sign',
      });
    });

    fireEvent.click(screen.getByLabelText('Reset closed PR emoji'));

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackPrClosedEmoji: 'x',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Closed PR')).toHaveValue('x');
    });
  });

  it('clears the summon emoji when clicking the clear button', async () => {
    mockSettingsState.current.slackSummonEmoji = 'shipit';
    await renderLoadedVibesSettings();

    fireEvent.click(screen.getByLabelText('Clear summon emoji'));

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackSummonEmoji: '',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Emoji name')).toHaveValue('');
    });

    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Removed custom summon emoji',
    );
  });

  it('clears the summon emoji to disable reaction-based summoning', async () => {
    mockSettingsState.current.slackSummonEmoji = 'shipit';
    await renderLoadedVibesSettings();

    const input = screen.getByLabelText('Emoji name');
    await changeControlledInput(input, '');
    await blurControlledInput(input);

    await waitFor(() => {
      expect(mockUpdateVibesSettings.mock.calls.at(-1)?.[0]).toEqual({
        slackSummonEmoji: '',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Emoji name')).toHaveValue('');
    });

    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Removed custom summon emoji',
    );
  });

  it('renders the suggested emoji downloads as same-origin links with download attributes', async () => {
    await renderLoadedVibesSettings();

    const links = screen.getAllByRole('link');

    expect(links).toHaveLength(5);
    expect(links[0]).toHaveAttribute(
      'href',
      '/vibes/ideas/roomote_right_black.png',
    );
    expect(links[0]).toHaveAttribute('download', 'roomote_right_black.png');
    expect(links[1]).toHaveAttribute(
      'href',
      '/vibes/ideas/roomote_right_green.png',
    );
    expect(links[1]).toHaveAttribute('download', 'roomote_right_green.png');
    expect(links[2]).toHaveAttribute(
      'href',
      '/vibes/ideas/roomote_up_black.png',
    );
    expect(links[2]).toHaveAttribute('download', 'roomote_up_black.png');
    expect(links[3]).toHaveAttribute(
      'href',
      '/vibes/ideas/roomote_up_green.png',
    );
    expect(links[3]).toHaveAttribute('download', 'roomote_up_green.png');
    expect(links[4]).toHaveAttribute(
      'href',
      '/vibes/ideas/let-me-roomote-that-for-you.png',
    );
    expect(links[4]).toHaveAttribute(
      'download',
      'let-me-roomote-that-for-you.png',
    );
  });
});
