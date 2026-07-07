'use client';

import { useState, type CSSProperties, type FocusEvent } from 'react';

import { Button, Input, Plus, Trash2 } from '@/components/system';
import { cn } from '@/lib/utils';

import {
  makeId,
  normalizeKeyValueRecord,
  recordToRows,
  serializeKeyValueRecord,
  type KeyValueRow,
} from './VisualEnvironmentEditor.model';
import { useEditableRows } from './useEditableRows';

type EditableField = 'key' | 'value';

export function KeyValueListEditor({
  value,
  onChange,
  keyLabel,
  valueLabel,
  emptyLabel,
  addLabel,
  inputClassName,
  allowEmptyValues,
  rowClassName,
  enableFocusResize,
  defaultRowWidth = '66.666667%',
  focusedRowWidth = '66.666667%',
}: {
  value?: Record<string, string>;
  onChange: (next: Record<string, string> | undefined) => void;
  keyLabel: string;
  valueLabel: string;
  emptyLabel: string;
  addLabel: string;
  inputClassName?: string;
  allowEmptyValues?: boolean;
  rowClassName?: string;
  enableFocusResize?: boolean;
  defaultRowWidth?: string;
  focusedRowWidth?: string;
}) {
  const { rows, updateRows } = useEditableRows<
    KeyValueRow,
    Record<string, string> | undefined
  >({
    value,
    onChange,
    valueToRows: recordToRows,
    rowsToValue: (nextRows) =>
      normalizeKeyValueRecord(nextRows, { allowEmptyValues }),
    serializeValue: serializeKeyValueRecord,
  });
  const [focusedFieldByRow, setFocusedFieldByRow] = useState<
    Partial<Record<string, EditableField>>
  >({});

  const handleFieldFocus = (rowId: string, field: EditableField) => {
    if (!enableFocusResize) {
      return;
    }

    setFocusedFieldByRow((current) =>
      current[rowId] === field ? current : { ...current, [rowId]: field },
    );
  };

  const handleFieldBlur = (
    rowId: string,
    event: FocusEvent<HTMLInputElement>,
  ) => {
    if (!enableFocusResize) {
      return;
    }

    const rowElement = event.currentTarget.parentElement;
    const nextFocusedElement = event.relatedTarget;

    if (
      rowElement &&
      nextFocusedElement instanceof HTMLInputElement &&
      rowElement.contains(nextFocusedElement)
    ) {
      return;
    }

    setFocusedFieldByRow((current) => {
      if (!(rowId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[rowId];
      return next;
    });
  };

  const getRowGridTemplateColumns = (focusedField?: EditableField) => {
    if (focusedField === 'key') {
      return 'minmax(0, 3fr) minmax(0, 1fr) auto';
    }

    if (focusedField === 'value') {
      return 'minmax(0, 1fr) minmax(0, 3fr) auto';
    }

    return 'minmax(0, 1fr) minmax(0, 1fr) auto';
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : null}

      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            'grid items-start gap-2 md:w-[var(--row-width)] md:[grid-template-columns:var(--row-grid-columns)]',
            enableFocusResize &&
              'transition-[grid-template-columns,width] duration-200 ease-out',
            rowClassName,
          )}
          style={
            {
              '--row-grid-columns': getRowGridTemplateColumns(
                enableFocusResize ? focusedFieldByRow[row.id] : undefined,
              ),
              '--row-width':
                enableFocusResize && focusedFieldByRow[row.id]
                  ? focusedRowWidth
                  : defaultRowWidth,
            } as CSSProperties
          }
        >
          <Input
            aria-label={keyLabel}
            value={row.key}
            placeholder={keyLabel}
            className={inputClassName}
            onFocus={() => handleFieldFocus(row.id, 'key')}
            onBlur={(event) => handleFieldBlur(row.id, event)}
            onChange={(event) =>
              updateRows(
                rows.map((currentRow) =>
                  currentRow.id === row.id
                    ? { ...currentRow, key: event.target.value }
                    : currentRow,
                ),
              )
            }
          />
          <Input
            aria-label={valueLabel}
            value={row.value}
            placeholder={valueLabel}
            className={inputClassName}
            onFocus={() => handleFieldFocus(row.id, 'value')}
            onBlur={(event) => handleFieldBlur(row.id, event)}
            onChange={(event) =>
              updateRows(
                rows.map((currentRow) =>
                  currentRow.id === row.id
                    ? { ...currentRow, value: event.target.value }
                    : currentRow,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${row.key || keyLabel}`}
            onClick={() =>
              updateRows(rows.filter((currentRow) => currentRow.id !== row.id))
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          updateRows([...rows, { id: makeId(), key: '', value: '' }])
        }
      >
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
