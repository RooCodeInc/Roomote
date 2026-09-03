'use client';

import {
  type ChangeEvent,
  type ChangeEventHandler,
  type ClipboardEventHandler,
  type ComponentProps,
  type FormEvent,
  type FormEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type RefObject,
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChatStatus, FileUIPart, SourceDocumentUIPart } from 'ai';
import {
  AtSignIcon,
  CornerDownLeftIcon,
  FileIcon,
  Loader2Icon,
  PlusIcon,
  SquareIcon,
  SquareSlashIcon,
  XIcon,
} from '@/components/system';

import { generateClientUuid } from '@/lib/client-uuid';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  BasicTooltip,
} from '@/components/system';

// ============================================================================
// Provider Context & Types
// ============================================================================

interface AttachmentsContext {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void,
  ) => void;
}

const PromptInputController = createContext<PromptInputControllerProps | null>(
  null,
);
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(
  null,
);

// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () =>
  useContext(PromptInputController);

const useOptionalProviderAttachments = () =>
  useContext(ProviderAttachmentsContext);

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  // Prefer local context (inside PromptInput) as it has validation, fall back to provider
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;

  if (!context) {
    throw new Error(
      'usePromptInputAttachments must be used within a PromptInput or PromptInputProvider',
    );
  }

  return context;
};

// ============================================================================
// Referenced Sources (Local to PromptInput)
// ============================================================================

interface ReferencedSourcesContext {
  sources: (SourceDocumentUIPart & { id: string })[];
  add: (sources: SourceDocumentUIPart[] | SourceDocumentUIPart) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const LocalReferencedSourcesContext =
  createContext<ReferencedSourcesContext | null>(null);

function getPastedFiles(items: DataTransferItemList | undefined): File[] {
  if (!items) {
    return [];
  }

  const pastedFiles: File[] = [];

  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }

    const file = item.getAsFile();

    if (file) {
      pastedFiles.push(file);
    }
  }

  return pastedFiles;
}

function clipboardContainsTabularText(
  clipboardData: DataTransfer | null | undefined,
): boolean {
  if (!clipboardData) {
    return false;
  }

  const tabSeparatedText = clipboardData
    .getData('text/tab-separated-values')
    .trim();

  if (tabSeparatedText.length > 0) {
    return true;
  }

  const csvText = clipboardData.getData('text/csv').trim();

  if (csvText.length > 0) {
    return true;
  }

  const html = clipboardData.getData('text/html');

  if (
    /<table[\s>]/i.test(html) ||
    (/<tr[\s>]/i.test(html) && /<td[\s>]/i.test(html))
  ) {
    return true;
  }

  const plainText = clipboardData.getData('text/plain');

  return /\t/.test(plainText) && /\r?\n/.test(plainText);
}

type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = 'Files',
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  return (
    <DropdownMenuItem
      {...props}
      onSelect={() => {
        attachments.openFileDialog();
      }}
    >
      <FileIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

type PromptInputActionAddContextProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddContext = ({
  label = 'Context',
  ...props
}: PromptInputActionAddContextProps) => {
  return (
    <DropdownMenuItem {...props}>
      <AtSignIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

type PromptInputActionAddCommandProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddCommand = ({
  label = 'Commands',
  ...props
}: PromptInputActionAddCommandProps) => {
  return (
    <DropdownMenuItem {...props}>
      <SquareSlashIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

type PromptInputProps = Omit<ComponentProps<'form'>, 'onSubmit' | 'onError'> & {
  accept?: string; // e.g., "image/*" or leave undefined for any
  multiple?: boolean;
  // When true, accepts drops anywhere on document. Default false (opt-in).
  globalDrop?: boolean;
  // Render a hidden input with given name and keep it in sync for native form posts. Default false.
  syncHiddenInput?: boolean;
  // Minimal constraints
  maxFiles?: number;
  maxFileSize?: number; // bytes
  onError?: (err: {
    code: 'max_files' | 'max_file_size' | 'accept';
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
  /** When false, the text input and attachments are NOT cleared after a successful submit. Default true. */
  clearOnSubmit?: boolean;
};

export const PromptInput = ({
  autoComplete: formAutoComplete,
  className,
  accept,
  multiple,
  globalDrop,
  id: formId,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  method: formMethod,
  name: formName,
  onError,
  onSubmit,
  clearOnSubmit = true,
  children,
  ...props
}: PromptInputProps) => {
  const promptInputId = useId().replace(/:/g, '');
  const generatedFormId = `prompt-input-form-${promptInputId}`;
  // Try to use a provider controller if present.
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  // Refs.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Local attachments (only used when no provider).
  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);
  const files = usingProvider ? controller.attachments.files : items;

  // Local referenced sources (always local to PromptInput)/
  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);
  filesRef.current = files;

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === '') {
        return true;
      }

      const normalizedFileType = f.type.trim().toLowerCase();
      const normalizedFileName = f.name.trim().toLowerCase();
      const patterns = accept
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        const normalizedPattern = pattern.toLowerCase();

        if (normalizedPattern.startsWith('.')) {
          return normalizedFileName.endsWith(normalizedPattern);
        }

        if (normalizedPattern.endsWith('/*')) {
          const prefix = normalizedPattern.slice(0, -1); // e.g. image/* -> image/.
          return normalizedFileType.startsWith(prefix);
        }

        return normalizedFileType === normalizedPattern;
      });
    },
    [accept],
  );

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList);
      const accepted = incoming.filter((f) => matchesAccept(f));

      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: 'accept',
          message: 'No files match the accepted types.',
        });

        return;
      }

      const withinSize = (f: File) =>
        maxFileSize ? f.size <= maxFileSize : true;

      const sized = accepted.filter(withinSize);

      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: 'max_file_size',
          message: 'All files exceed the maximum size.',
        });

        return;
      }

      setItems((prev) => {
        const capacity =
          typeof maxFiles === 'number'
            ? Math.max(0, maxFiles - prev.length)
            : undefined;

        const capped =
          typeof capacity === 'number' ? sized.slice(0, capacity) : sized;

        if (typeof capacity === 'number' && sized.length > capacity) {
          onError?.({
            code: 'max_files',
            message: 'Too many files. Some were not added.',
          });
        }

        const next: (FileUIPart & { id: string })[] = [];

        for (const file of capped) {
          next.push({
            id: generateClientUuid(),
            type: 'file',
            url: URL.createObjectURL(file),
            mediaType: file.type,
            filename: file.name,
          });
        }

        return prev.concat(next);
      });
    },
    [matchesAccept, maxFiles, maxFileSize, onError],
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);

        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }

        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  // Wrapper that validates files before calling provider's add.
  const addWithProviderValidation = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList);
      const accepted = incoming.filter((f) => matchesAccept(f));

      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: 'accept',
          message: 'No files match the accepted types.',
        });

        return;
      }

      const withinSize = (f: File) =>
        maxFileSize ? f.size <= maxFileSize : true;

      const sized = accepted.filter(withinSize);

      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: 'max_file_size',
          message: 'All files exceed the maximum size.',
        });

        return;
      }

      const currentCount = files.length;

      const capacity =
        typeof maxFiles === 'number'
          ? Math.max(0, maxFiles - currentCount)
          : undefined;

      const capped =
        typeof capacity === 'number' ? sized.slice(0, capacity) : sized;

      if (typeof capacity === 'number' && sized.length > capacity) {
        onError?.({
          code: 'max_files',
          message: 'Too many files. Some were not added.',
        });
      }

      if (capped.length > 0) {
        controller?.attachments.add(capped);
      }
    },
    [matchesAccept, maxFileSize, maxFiles, onError, files.length, controller],
  );

  const clearAttachments = useCallback(
    () =>
      usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
              if (file.url) {
                URL.revokeObjectURL(file.url);
              }
            }
            return [];
          }),
    [usingProvider, controller],
  );

  const clearReferencedSources = useCallback(
    () => setReferencedSources([]),
    [],
  );

  const add = usingProvider ? addWithProviderValidation : addLocal;

  const remove = usingProvider ? controller.attachments.remove : removeLocal;

  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);

  // Let provider know about our hidden file input so external menus can call openFileDialog().
  useEffect(() => {
    if (!usingProvider) {
      return;
    }

    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  // Note: File input cannot be programmatically set for security reasons.
  // The syncHiddenInput prop is no longer functional.
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = '';
    }
  }, [files, syncHiddenInput]);

  // Attach drop handlers on nearest form and document (opt-in).
  useEffect(() => {
    const form = formRef.current;

    if (!form) {
      return;
    }

    if (globalDrop) {
      return; // When global drop is on, let the document-level handler own drops.
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };

    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };

    form.addEventListener('dragover', onDragOver);

    form.addEventListener('drop', onDrop);

    return () => {
      form.removeEventListener('dragover', onDragOver);
      form.removeEventListener('drop', onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    if (!globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };

    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);

    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url);
          }
        }
      }
    },
    [usingProvider],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.files) {
      add(event.currentTarget.files);
    }

    // Reset input value to allow selecting files that were previously removed.
    event.currentTarget.value = '';
  };

  const convertBlobUrlToDataUrl = async (
    url: string,
  ): Promise<string | null> => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map((item) => ({ ...item, id: item.id })),
      add,
      remove,
      clear: clearAttachments,
      openFileDialog,
      fileInputRef: inputRef,
    }),
    [files, add, remove, clearAttachments, openFileDialog],
  );

  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      sources: referencedSources,
      add: (incoming: SourceDocumentUIPart[] | SourceDocumentUIPart) => {
        const array = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((prev) =>
          prev.concat(array.map((s) => ({ ...s, id: generateClientUuid() }))),
        );
      },
      remove: (id: string) => {
        setReferencedSources((prev) => prev.filter((s) => s.id !== id));
      },
      clear: clearReferencedSources,
    }),
    [referencedSources, clearReferencedSources],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();

    const form = event.currentTarget;

    const text = usingProvider
      ? controller.textInput.value
      : (() => {
          const formData = new FormData(form);
          return (formData.get('message') as string) || '';
        })();

    const clearAll = () => {
      clear();

      if (usingProvider) {
        controller.textInput.clear();
      } else {
        form.reset();
      }
    };

    // Convert blob URLs to data URLs asynchronously.
    Promise.all(
      files.map(async ({ id: _id, ...item }) => {
        if (item.url?.startsWith('blob:')) {
          const dataUrl = await convertBlobUrlToDataUrl(item.url);
          // If conversion failed, keep the original blob URL.
          return { ...item, url: dataUrl ?? item.url };
        }

        return item;
      }),
    )
      .then((convertedFiles: FileUIPart[]) => {
        try {
          const result = onSubmit({ text, files: convertedFiles }, event);

          // Handle both sync and async onSubmit.
          if (result instanceof Promise) {
            result
              .then(() => {
                if (clearOnSubmit) clearAll();
              })
              .catch(() => {
                // Don't clear on error - user may want to retry.
              });
          } else if (clearOnSubmit) {
            // Sync function completed without throwing, clear inputs.
            clearAll();
          }
        } catch {
          // Don't clear on error - user may want to retry.
        }
      })
      .catch(() => {
        // Don't clear on error - user may want to retry.
      });
  };

  // Render with or without local provider.
  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <form
        autoComplete={formAutoComplete ?? 'off'}
        className={cn('w-full', className)}
        id={formId ?? generatedFormId}
        method={formMethod ?? 'post'}
        name={formName ?? generatedFormId}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        <div className="overflow-hidden rounded-none shadow-none">
          {children}
        </div>
      </form>
    </>
  );

  const withReferencedSources = (
    <LocalReferencedSourcesContext.Provider value={refsCtx}>
      {inner}
    </LocalReferencedSourcesContext.Provider>
  );

  // Always provide LocalAttachmentsContext so children get validated add function.
  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      {withReferencedSources}
    </LocalAttachmentsContext.Provider>
  );
};

type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn('contents', className)} {...props} />
);

type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea> & {
  /** When true, only Cmd+Enter (or Ctrl+Enter) submits; plain Enter inserts a newline. */
  submitWithMetaKey?: boolean;
};

// Feature-detect CSS `field-sizing: content` once at module level.
// When unsupported (e.g. Firefox), we fall back to JS-based auto-resize.
const supportsFieldSizing =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

export const PromptInputTextarea = ({
  id,
  onChange,
  onKeyDown,
  className,
  name,
  placeholder,
  submitWithMetaKey,
  ref: externalRef,
  ...props
}: PromptInputTextareaProps) => {
  const textareaId = useId().replace(/:/g, '');
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement>(null);

  // Merge the internal ref with any forwarded external ref so both
  // the auto-resize logic and calling code can access the <textarea>.
  const mergedRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      internalRef.current = node;

      if (typeof externalRef === 'function') {
        externalRef(node);
      } else if (externalRef) {
        (externalRef as { current: HTMLTextAreaElement | null }).current = node;
      }
    },
    [externalRef],
  );

  // JS-based auto-resize for browsers that don't support field-sizing.
  const autoResize = useCallback(() => {
    const el = internalRef.current;

    if (!el || supportsFieldSizing) {
      return;
    }

    // Temporarily collapse so scrollHeight reflects content, not the
    // previously expanded height.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Re-run auto-resize whenever the controlled value changes.
  const controlledValue = controller
    ? controller.textInput.value
    : (props.value as string | undefined);

  useEffect(() => {
    autoResize();
  }, [controlledValue, autoResize]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Call the external onKeyDown handler first.
    onKeyDown?.(e);

    // If the external handler prevented default, don't run internal logic.
    if (e.defaultPrevented) {
      return;
    }

    if (e.key === 'Enter') {
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }

      // When submitWithMetaKey is enabled, only submit on Cmd/Ctrl+Enter.
      // Plain Enter inserts a newline (default textarea behavior).
      if (submitWithMetaKey) {
        if (!e.metaKey && !e.ctrlKey) {
          return;
        }
      } else if (e.shiftKey) {
        return;
      }

      e.preventDefault();

      // Check if the submit button is disabled before submitting.
      const form = e.currentTarget.form;

      const submitButton = form?.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement | null;

      if (submitButton?.disabled) {
        return;
      }

      form?.requestSubmit();
    }

    // Remove last attachment when Backspace is pressed and textarea is empty.
    if (
      e.key === 'Backspace' &&
      e.currentTarget.value === '' &&
      attachments.files.length > 0
    ) {
      e.preventDefault();
      const lastAttachment = attachments.files.at(-1);

      if (lastAttachment) {
        attachments.remove(lastAttachment.id);
      }
    }
  };

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    const pastedFiles = getPastedFiles(event.clipboardData?.items);

    if (pastedFiles.length === 0) {
      return;
    }

    const hasOnlyImageFiles = pastedFiles.every((file) =>
      file.type.startsWith('image/'),
    );

    if (
      hasOnlyImageFiles &&
      clipboardContainsTabularText(event.clipboardData)
    ) {
      return;
    }

    event.preventDefault();
    attachments.add(pastedFiles);
  };

  const controlledProps = controller
    ? {
        value: controller.textInput.value,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
          autoResize();
        },
      }
    : {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          onChange?.(e);
          autoResize();
        },
      };

  return (
    <InputGroupTextarea
      className={cn(
        'field-sizing-content disabled:bg-transparent disabled:opacity-50 transition-all',
        'max-h-[50svh] overflow-y-auto',
        'p-4',
        className,
      )}
      data-op-ignore="true"
      id={id ?? `prompt-input-textarea-${textareaId}`}
      name={name ?? 'message'}
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      autoComplete="off"
      {...props}
      {...controlledProps}
      ref={mergedRef}
    />
  );
};

type PromptInputHeaderProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  'align'
>;

export const PromptInputHeader = ({
  className,
  ...props
}: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('order-first flex-wrap gap-1', className)}
    {...props}
  />
);

type PromptInputFooterProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  'align'
>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('justify-between gap-1', className)}
    {...props}
  />
);

type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props} />
);

type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputButton = ({
  variant = 'ghost',
  className,
  size,
  ...props
}: PromptInputButtonProps) => {
  const newSize =
    size ?? (Children.count(props.children) > 1 ? 'sm' : 'icon-sm');

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
};

type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;

export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
);

type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger asChild>
    <PromptInputButton className={className} {...props}>
      {children ?? <PlusIcon className="size-4" />}
    </PromptInputButton>
  </DropdownMenuTrigger>
);

type PromptInputActionMenuContentProps = ComponentProps<
  typeof DropdownMenuContent
>;

export const PromptInputActionMenuContent = ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align="start" className={cn(className)} {...props} />
);

type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
  tooltip?: string;
};

export const PromptInputSubmit = ({
  className,
  variant = 'default',
  size = 'icon-sm',
  status,
  onStop,
  onClick,
  children,
  tooltip = 'Send (Enter)',
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === 'submitted' || status === 'streaming';

  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === 'submitted') {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === 'streaming') {
    Icon = <SquareIcon className="size-3.5 fill-current" />;
  } else if (status === 'error') {
    Icon = <XIcon className="size-4" />;
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isGenerating && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    onClick?.(e);
  };

  return (
    <BasicTooltip content={tooltip}>
      <InputGroupButton
        aria-label={isGenerating ? 'Stop' : 'Submit'}
        className={cn(
          'rounded-full transition-colors',
          isGenerating && 'bg-red-500/30 text-red-600 hover:bg-red-500/50',
          className,
        )}
        onClick={handleClick}
        size={size}
        type={isGenerating && onStop ? 'button' : 'submit'}
        variant={isGenerating ? 'ghost' : variant}
        {...props}
      >
        {children ?? Icon}
      </InputGroupButton>
    </BasicTooltip>
  );
};
