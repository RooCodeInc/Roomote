'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { yaml } from '@codemirror/lang-yaml';
import { MergeView } from '@codemirror/merge';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';

import { Lock, Pencil } from '@/components/system';
import { cn } from '@/lib/utils';

// githubLight/githubDark already provide full editor chrome (background,
// gutters, selection, syntax colors) matching the same GitHub palette the
// shiki-based code blocks elsewhere in the app use.
const fontTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.8rem',
  },
});

function sideExtensions(dark: boolean) {
  return [basicSetup, yaml(), fontTheme, dark ? githubDark : githubLight];
}

interface EnvironmentDiffMergeViewProps {
  /** Saved/baseline YAML, shown read-only on the left. */
  original: string;
  /** Editable draft YAML, shown on the right. */
  modified: string;
  onModifiedChange: (value: string) => void;
  className?: string;
  /** Label for the left (read-only) pane. Defaults to "Saved configuration". */
  originalLabel?: string;
  /** Label for the right (editable) pane. Defaults to "Editing". */
  modifiedLabel?: string;
}

export function EnvironmentDiffMergeView({
  original,
  modified,
  onModifiedChange,
  className,
  originalLabel = 'Saved configuration',
  modifiedLabel = 'Editing',
}: EnvironmentDiffMergeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const lastEmittedRef = useRef(modified);
  const onModifiedChangeRef = useRef(onModifiedChange);
  onModifiedChangeRef.current = onModifiedChange;

  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const mergeView = new MergeView({
      parent: containerRef.current,
      a: {
        doc: original,
        extensions: [...sideExtensions(dark), EditorState.readOnly.of(true)],
      },
      b: {
        doc: modified,
        extensions: [
          ...sideExtensions(dark),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
              return;
            }

            const value = update.state.doc.toString();
            lastEmittedRef.current = value;
            onModifiedChangeRef.current(value);
          }),
        ],
      },
      gutter: true,
      highlightChanges: true,
    });

    mergeViewRef.current = mergeView;

    return () => {
      mergeView.destroy();
      mergeViewRef.current = null;
    };
    // A theme change is the only prop that should tear down and rebuild the whole view;
    // `original`/`modified` updates are pushed into the live view by the effects below instead,
    //  so they don't clobber in-progress edits or cursor position on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  useEffect(() => {
    const mergeView = mergeViewRef.current;

    if (!mergeView) {
      return;
    }

    const currentA = mergeView.a.state.doc.toString();

    if (currentA !== original) {
      mergeView.a.dispatch({
        changes: { from: 0, to: currentA.length, insert: original },
      });
    }
  }, [original]);

  useEffect(() => {
    const mergeView = mergeViewRef.current;

    if (!mergeView || modified === lastEmittedRef.current) {
      return;
    }

    const currentB = mergeView.b.state.doc.toString();

    if (currentB !== modified) {
      mergeView.b.dispatch({
        changes: { from: 0, to: currentB.length, insert: modified },
      });
    }

    lastEmittedRef.current = modified;
  }, [modified]);

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border',
        className,
      )}
    >
      <div className="grid grid-cols-2 shrink-0 border-b bg-muted/80 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 border-r px-3 py-1.5">
          <Lock className="size-3" />
          {originalLabel}
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          <Pencil className="size-3" />
          {modifiedLabel}
        </div>
      </div>
      <div
        ref={containerRef}
        className={cn(
          'min-h-0 flex-1 overflow-hidden',
          '[&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-auto',
          '[&_.cm-editor]:h-full',
        )}
      />
    </div>
  );
}
