'use client';

import {
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  Children,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type ThemedToken,
  createHighlighter,
} from 'shiki';
import { ASCIISpinner, DollarSign, FileDiffIcon } from '@/components/system';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import { cn } from '@/lib/utils';

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

import {
  CollapsibleIconTrigger,
  CopyIconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline.

const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;

const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;

const isUnderline = (fontStyle: number | undefined) =>
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint.
interface KeyedToken {
  token: ThemedToken;
  key: string;
}

interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      token,
      key: `line-${lineIdx}-${tokenIdx}`,
    })),
  }));

// Token rendering component.
const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!"
    style={
      {
        color: token.color,
        backgroundColor: token.bgColor,
        ...token.htmlStyle,
        fontStyle: isItalic(token.fontStyle) ? 'italic' : undefined,
        fontWeight: isBold(token.fontStyle) ? 'bold' : undefined,
        textDecoration: isUnderline(token.fontStyle) ? 'underline' : undefined,
      } as CSSProperties
    }
  >
    {token.content}
  </span>
);

// Line number styles using CSS counters.
const LINE_NUMBER_CLASSES = cn(
  'block',
  'before:content-[counter(line)]',
  'before:inline-block',
  'before:[counter-increment:line]',
  'before:w-4',
  'before:mr-4',
  'before:text-right',
  'before:text-muted-foreground/50',
  'before:font-mono',
  'before:select-none',
);

// Line rendering component.
const LineSpan = ({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine;
  showLineNumbers: boolean;
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : 'block'}>
    {keyedLine.tokens.length === 0
      ? '\n'
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
        ))}
  </span>
);

type CodeBlockVariant = 'default' | 'compact';

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  collapsible?: boolean;
  /** Initial collapsed state when `collapsible` is true. @default collapsible */
  defaultCollapsed?: boolean;
  forceDark?: boolean;
  /**
   * Visual variant. `compact` removes the container background/border and
   * reduces header & font chrome — intended for inline command output.
   * @default 'default'
   */
  variant?: CodeBlockVariant;
  /**
   * When false, the default CodeBlockContent is not rendered — useful when
   * providing a custom body like CodeBlockDiffContent.
   */
  renderContent?: boolean;
  /**
   * When true, shows a "Copy command" button in the header area.
   * Copies the `command` string if provided, otherwise the `code`.
   */
  showCommandCopy?: boolean;
  /**
   * When true, shows a "Copy output" button inside the expanded content area.
   */
  showOutputCopy?: boolean;
  /**
   * Command string to display and copy. Used by showCommandCopy.
   */
  command?: string;
  /**
   * When set, caps the content area height and enables vertical scrolling.
   */
  maxHeight?: number | string;
  /**
   * When false, disables Shiki syntax highlighting and renders plain
   * monochrome text. Useful for raw output or logs.
   * @default true
   */
  highlight?: boolean;
};

interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

interface CodeBlockContextType {
  code: string;
  command?: string;
  collapsible: boolean;
  isCollapsed: boolean;
  showCommandCopy: boolean;
  variant: CodeBlockVariant;
  toggleCollapsed: () => void;
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: '',
  collapsible: false,
  isCollapsed: false,
  showCommandCopy: false,
  variant: 'default',
  toggleCollapsed: () => {},
});

// Highlighter cache (singleton per language)
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();

// Token cache
const tokensCache = new Map<string, TokenizedCode>();

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

const getTokensCacheKey = (code: string, language: BundledLanguage) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : '';
  return `${language}:${code.length}:${start}:${end}`;
};

const getHighlighter = (
  language: BundledLanguage,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cached = highlighterCache.get(language);

  if (cached) {
    return cached;
  }

  const fallbackLanguage: BundledLanguage = 'shell';

  const createForLanguage = (lang: BundledLanguage) =>
    createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [lang],
    });

  let highlighterPromise: Promise<
    HighlighterGeneric<BundledLanguage, BundledTheme>
  >;

  try {
    highlighterPromise = createForLanguage(language);
  } catch (error) {
    console.warn(
      `Shiki language "${language}" is unavailable, falling back to "${fallbackLanguage}".`,
      error,
    );

    highlighterPromise = createForLanguage(fallbackLanguage);
  }

  highlighterPromise = highlighterPromise.catch((error) => {
    if (language === fallbackLanguage) {
      throw error;
    }

    console.warn(
      `Shiki language "${language}" is unavailable, falling back to "${fallbackLanguage}".`,
      error,
    );

    return createForLanguage(fallbackLanguage);
  });

  highlighterCache.set(language, highlighterPromise);
  return highlighterPromise;
};

const trimTrailingEmptyLine = (lines: string[]) => {
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
};

// Create raw tokens for immediate display while highlighting loads.
const createRawTokens = (code: string): TokenizedCode => {
  const lines = trimTrailingEmptyLine(code.split('\n'));

  return {
    tokens: lines.map((line) =>
      line === '' ? [] : [{ content: line, color: 'inherit' } as ThemedToken],
    ),
    fg: 'inherit',
    bg: 'transparent',
  };
};

// Synchronous highlight with callback for async results.
function highlightCode(
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null {
  const tokensCacheKey = getTokensCacheKey(code, language);

  // Return cached result if available.
  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    return cached;
  }

  // Subscribe callback if provided.
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }

    subscribers.get(tokensCacheKey)?.add(callback);
  }

  // Start highlighting in background.
  getHighlighter(language)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(language) ? language : 'text';

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: { light: 'github-light', dark: 'github-dark' },
      });

      const tokenized: TokenizedCode = {
        tokens: result.tokens,
        fg: result.fg ?? 'inherit',
        bg: result.bg ?? 'transparent',
      };

      // Cache the result.
      tokensCache.set(tokensCacheKey, tokenized);

      // Notify all subscribers.
      const subs = subscribers.get(tokensCacheKey);

      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }

        subscribers.delete(tokensCacheKey);
      }
    })
    .catch((error) => {
      console.error('Failed to highlight code:', error);
      subscribers.delete(tokensCacheKey);
    });

  return null;
}

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    highlight = true,
    className,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    highlight?: boolean;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    const keyedLines = useMemo(() => {
      const tokens = tokenized.tokens;
      if (tokens.length > 1 && tokens[tokens.length - 1]?.length === 0) {
        return addKeysToTokens(tokens.slice(0, -1));
      }

      return addKeysToTokens(tokens);
    }, [tokenized.tokens]);

    return (
      <pre
        className={cn(
          'm-0 min-w-fit px-3 py-2',
          highlight && 'dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!',
          className,
        )}
        style={{
          ...preStyle,
          ...(!highlight
            ? ({
                '--shiki-dark': 'inherit',
                '--shiki-dark-bg': 'transparent',
              } as CSSProperties)
            : undefined),
        }}
      >
        <code
          className={cn(
            'font-mono font-regular text-[0.7rem]',
            showLineNumbers &&
              '[counter-increment:line_0] [counter-reset:line]',
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.highlight === nextProps.highlight &&
    prevProps.className === nextProps.className,
);

CodeBlockBody.displayName = 'CodeBlockBody';

const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => {
  const { variant } = useContext(CodeBlockContext);
  const isCompact = variant === 'compact';

  return (
    <div
      className={cn(
        'group relative w-full overflow-hidden',
        isCompact
          ? 'text-foreground text-[12px]'
          : 'rounded-xl border bg-background text-foreground',
        className,
      )}
      data-language={language}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 200px',
        ...style,
      }}
      {...props}
    />
  );
};

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <CodeBlockHeaderContent className={className} {...props}>
    {children}
  </CodeBlockHeaderContent>
);

const CodeBlockHeaderContent = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const {
    collapsible,
    isCollapsed,
    toggleCollapsed,
    showCommandCopy,
    command,
    code,
    variant,
  } = useContext(CodeBlockContext);
  const isCompact = variant === 'compact';

  return (
    <div
      className={cn(
        'group flex gap-2 justify-between text-xs',
        isCompact ? 'p-0' : 'bg-muted/80 p-1 border-b text-muted-foreground',
        collapsible && 'cursor-pointer select-none',
        className,
      )}
      onClick={collapsible ? toggleCollapsed : undefined}
      role={collapsible ? 'button' : undefined}
      aria-expanded={collapsible ? !isCollapsed : undefined}
      data-state={collapsible ? (!isCollapsed ? 'open' : 'closed') : undefined}
      tabIndex={collapsible ? 0 : undefined}
      onKeyDown={
        collapsible
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleCollapsed();
              }
            }
          : undefined
      }
      {...props}
    >
      {children}
      {showCommandCopy && !isCollapsed && (
        <CodeBlockActions className="animate-[enter-down_100ms_1] items-start">
          <CodeBlockCopyButton
            text={command ?? code}
            tooltip="Copy command"
            className={isCompact ? 'mr-3' : 'mt-1 mr-1'}
          />
        </CodeBlockActions>
      )}
    </div>
  );
};

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const { variant } = useContext(CodeBlockContext);
  const isCompact = variant === 'compact';

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2',
        isCompact ? 'p-0' : 'p-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('font-mono', className)} {...props}>
    {children}
  </span>
);

export const CodeBlockCommand = ({
  spinner = false,
  highlight = true,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  spinner?: boolean;
  /** When false, skips Shiki and renders plain monochrome text. @default true */
  highlight?: boolean;
}) => {
  const { variant } = useContext(CodeBlockContext);
  const isCompact = variant === 'compact';
  const text = useMemo(
    () =>
      Children.toArray(children)
        .map((child) =>
          typeof child === 'string' || typeof child === 'number'
            ? String(child)
            : '',
        )
        .join(''),
    [children],
  );

  const rawTokens = useMemo(() => createRawTokens(text), [text]);

  const [tokenized, setTokenized] = useState<TokenizedCode>(
    () => (highlight ? highlightCode(text, 'bash') : null) ?? rawTokens,
  );

  useEffect(() => {
    if (!highlight) {
      setTokenized(rawTokens);
      return;
    }

    setTokenized(highlightCode(text, 'bash') ?? rawTokens);
    highlightCode(text, 'bash', setTokenized);
  }, [text, rawTokens, highlight]);

  const allLines = tokenized.tokens;

  return (
    <span
      className={cn(
        'font-mono text-foreground flex min-w-0 flex-1 gap-2 items-start',
        isCompact &&
          'text-[12px] text-muted-foreground overflow-hidden group-data-[state=open]:mb-2 group-data-[state=open]:mt-1',
        className,
      )}
      {...props}
    >
      {spinner ? (
        <ASCIISpinner
          className={cn('-mt-0.5 shrink-0', isCompact && 'size-3')}
        />
      ) : (
        <CollapsibleIconTrigger
          icon={DollarSign}
          className={cn(
            'mt-0.75 shrink-0 text-muted-background',
            isCompact && 'size-3',
          )}
        />
      )}
      <span
        className="block min-w-0 group-data-[state=closed]:truncate group-data-[state=open]:whitespace-pre-wrap group-data-[state=open]:break-words"
        style={{ '--shiki-dark-bg': 'transparent' } as CSSProperties}
      >
        {highlight && allLines.length > 0
          ? allLines.map((lineTokens, lineIdx) => (
              <span key={`cmd-line-${lineIdx}`}>
                {lineIdx > 0 && '\n'}
                {lineTokens.map((token, tokenIdx) => (
                  <TokenSpan key={`cmd-${lineIdx}-${tokenIdx}`} token={token} />
                ))}
              </span>
            ))
          : text}
      </span>
    </span>
  );
};

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-2 relative', className)} {...props}>
    {children}
  </div>
);

const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
  highlight = true,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  /** When false, skips Shiki and renders plain monochrome text. @default true */
  highlight?: boolean;
}) => {
  // Memoized raw tokens for immediate display
  const rawTokens = useMemo(() => createRawTokens(code), [code]);

  // Try to get cached result synchronously, otherwise use raw tokens
  const [tokenized, setTokenized] = useState<TokenizedCode>(
    () => (highlight ? highlightCode(code, language) : null) ?? rawTokens,
  );

  useEffect(() => {
    if (!highlight) {
      setTokenized(rawTokens);
      return;
    }

    // Reset to raw tokens when code changes (shows current code, not stale tokens)
    setTokenized(highlightCode(code, language) ?? rawTokens);

    // Subscribe to async highlighting result
    highlightCode(code, language, setTokenized);
  }, [code, language, rawTokens, highlight]);

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody
        showLineNumbers={showLineNumbers}
        highlight={highlight}
        tokenized={tokenized}
      />
    </div>
  );
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  collapsible = false,
  defaultCollapsed = collapsible,
  forceDark = false,
  renderContent = true,
  showCommandCopy = false,
  showOutputCopy = false,
  command,
  maxHeight,
  highlight = true,
  variant = 'default',
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const initialCollapsed = collapsible ? defaultCollapsed : false;
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const prevCollapsibleRef = useRef(collapsible);

  useEffect(() => {
    const wasCollapsible = prevCollapsibleRef.current;

    if (!collapsible) {
      if (isCollapsed) {
        setIsCollapsed(false);
      }
      prevCollapsibleRef.current = collapsible;
      return;
    }

    // If collapsible is enabled after first render, apply the configured
    // default collapsed state without requiring a parent remount.
    if (!wasCollapsible) {
      setIsCollapsed(defaultCollapsed);
    }

    prevCollapsibleRef.current = collapsible;
  }, [collapsible, defaultCollapsed, isCollapsed]);

  const contextValue = useMemo(
    () => ({
      code,
      command,
      collapsible,
      isCollapsed,
      showCommandCopy,
      variant,
      toggleCollapsed: () => setIsCollapsed((prev) => !prev),
    }),
    [code, command, collapsible, isCollapsed, showCommandCopy, variant],
  );

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer
        className={cn(forceDark && variant !== 'compact' && 'dark', className)}
        language={language}
        {...props}
      >
        {children}
        {renderContent && !isCollapsed && (
          <div
            className={cn(
              'relative',
              forceDark && variant === 'compact' && 'dark',
              variant === 'compact' &&
                'bg-muted/50 text-foreground rounded-xl overflow-hidden',
              maxHeight && '[&>div]:overflow-visible',
            )}
            style={{
              scrollbarGutter: 'stable',
              ...(maxHeight
                ? {
                    maxHeight:
                      typeof maxHeight === 'number'
                        ? `${maxHeight}px`
                        : maxHeight,
                    overflow: 'auto',
                  }
                : undefined),
            }}
          >
            {showOutputCopy && (
              <div className="absolute right-0 top-1 z-10">
                <CodeBlockCopyButton
                  tooltip="Copy output"
                  className="animate-[enter-down_100ms_1]"
                />
              </div>
            )}
            <CodeBlockContent
              code={code}
              language={language}
              showLineNumbers={showLineNumbers}
              highlight={highlight}
            />
          </div>
        )}
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

type CodeBlockCopyButtonProps = Omit<ButtonAsButtonProps, 'children'> & {
  /** Override the text to copy instead of reading from CodeBlock context. */
  text?: string;
  /** When provided, wraps the button in a Tooltip with this label. */
  tooltip?: ReactNode;
  onCopy?: () => void;
};

export const CodeBlockCopyButton = ({
  text,
  tooltip,
  onCopy,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const { code } = useContext(CodeBlockContext);

  return (
    <CopyIconButton
      content={text ?? code}
      tooltip={tooltip}
      onCopied={onCopy}
      className={cn('shrink-0 text-muted-foreground', className)}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      {...props}
    />
  );
};

type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps,
) => <Select {...props} />;

type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn(
      'h-7 border-none bg-transparent px-2 text-xs shadow-none',
      className,
    )}
    {...props}
  />
);

type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps,
) => <SelectValue {...props} />;

type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>;

export const CodeBlockLanguageSelectorContent = ({
  align = 'end',
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
);

type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps,
) => <SelectItem {...props} />;

// --- Diff components ---

/**
 * Title component for diff-style CodeBlock headers.
 * Shows a file-diff icon, file path, and addition/deletion stats.
 */
export const CodeBlockDiff = ({
  path,
  additions,
  deletions,
}: {
  path: string;
  additions: number;
  deletions: number;
}) => (
  <span className="font-mono text-foreground flex gap-2 items-center">
    <FileDiffIcon className="size-4 opacity-50" strokeWidth={1.5} />
    <span className="truncate">{path}</span>
    <span className="flex gap-1.5 text-xs ml-auto shrink-0">
      {additions > 0 && <span className="text-green-600">+{additions}</span>}
      {deletions > 0 && <span className="text-red-500">-{deletions}</span>}
    </span>
  </span>
);

/**
 * Diff line background class lookup.
 */
const DIFF_LINE_BG: Record<DiffLine['type'], string> = {
  add: 'bg-green-500/10',
  remove: 'bg-red-500/10',
  context: '',
};

const DIFF_PREFIX_COLOR: Record<DiffLine['type'], string> = {
  add: 'text-green-600 dark:text-green-400',
  remove: 'text-red-500 dark:text-red-400',
  context: 'text-muted-foreground/50',
};

const DIFF_PREFIX_CHAR: Record<DiffLine['type'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

/**
 * DiffLineSpan renders a single highlighted diff line with prefix and background.
 */
const DiffLineSpan = ({
  keyedLine,
  diffType,
}: {
  keyedLine: KeyedLine;
  diffType: DiffLine['type'];
}) => (
  <span
    className={cn('block first:pt-2 last:pb-2', DIFF_LINE_BG[diffType])}
    style={{ '--shiki-dark-bg': 'transparent' } as CSSProperties}
  >
    <span
      className={cn(
        'inline-block w-4 mr-3 px-2 text-right select-none font-mono',
        DIFF_PREFIX_COLOR[diffType],
      )}
    >
      {DIFF_PREFIX_CHAR[diffType]}
    </span>
    {keyedLine.tokens.length === 0
      ? '\n'
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
        ))}
  </span>
);

/**
 * Body component that renders syntax-highlighted diff lines.
 * Each line gets a per-type background color and a +/- prefix.
 */
export const CodeBlockDiffContent = ({
  lines,
  language,
}: {
  lines: DiffLine[];
  language: BundledLanguage;
}) => {
  // Combine all line contents for shiki tokenization
  const code = lines.map((l) => l.content).join('\n');
  const rawTokens = useMemo(() => createRawTokens(code), [code]);

  const [tokenized, setTokenized] = useState<TokenizedCode>(
    () => highlightCode(code, language) ?? rawTokens,
  );

  useEffect(() => {
    setTokenized(highlightCode(code, language) ?? rawTokens);
    highlightCode(code, language, setTokenized);
  }, [code, language, rawTokens]);

  const preStyle = useMemo(
    () => ({
      backgroundColor: tokenized.bg,
      color: tokenized.fg,
    }),
    [tokenized.bg, tokenized.fg],
  );

  // Map each tokenized line back to its diff type
  const keyedLines = useMemo(
    () => addKeysToTokens(tokenized.tokens),
    [tokenized.tokens],
  );

  // Trim trailing empty token line if present (shiki artifact)
  const effectiveLines = useMemo(() => {
    if (
      keyedLines.length > lines.length &&
      keyedLines[keyedLines.length - 1]?.tokens.length === 0
    ) {
      return keyedLines.slice(0, lines.length);
    }
    return keyedLines.slice(0, lines.length);
  }, [keyedLines, lines.length]);

  return (
    <div className="relative overflow-auto">
      <pre
        className={cn(
          'dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)! m-0 min-w-fit px-3 py-2',
        )}
        style={preStyle}
      >
        <code className="font-mono font-regular text-[0.7rem]">
          {effectiveLines.map((keyedLine, idx) => (
            <DiffLineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              diffType={lines[idx]?.type ?? 'context'}
            />
          ))}
        </code>
      </pre>
    </div>
  );
};
