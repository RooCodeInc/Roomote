'use client';

import { type NamedPort } from '@roomote/types';

import { Badge, Button, Input, Plus, Trash2 } from '@/components/system';

import {
  makeId,
  normalizePorts,
  portsToRows,
  serializePorts,
  type PortRow,
} from './VisualEnvironmentEditor.model';
import { useEditableRows } from './useEditableRows';

export function PortListEditor({
  ports,
  onChange,
}: {
  ports?: NamedPort[];
  onChange: (next: NamedPort[] | undefined) => void;
}) {
  const { rows, updateRows } = useEditableRows<
    PortRow,
    NamedPort[] | undefined
  >({
    value: ports,
    onChange,
    valueToRows: portsToRows,
    rowsToValue: normalizePorts,
    serializeValue: serializePorts,
  });

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          Nothing configured yet.
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="text-sm font-semibold flex gap-2 items-center">
          <span className="w-40">Service name</span>
          <span className="w-24">Port</span>
          <span className="grow">Starting path</span>
        </div>
      )}

      {rows.map((row) => {
        const hiddenFields = [
          row.unauthenticated ? 'public' : null,
          row.proxied === false ? 'direct' : null,
          row.subdomain ? 'subdomain' : null,
          row.wildcard_prefix ? 'wildcard' : null,
          row.auth_bypass_paths && row.auth_bypass_paths.length > 0
            ? 'bypass paths'
            : null,
        ].filter((value): value is string => Boolean(value));

        return (
          <div key={row.id} className="space-y-3">
            <div className="flex gap-2 items-center">
              <Input
                aria-label="Port name"
                className="w-40 shrink-0"
                value={row.name}
                placeholder="Name"
                onChange={(event) =>
                  updateRows(
                    rows.map((currentRow) =>
                      currentRow.id === row.id
                        ? { ...currentRow, name: event.target.value }
                        : currentRow,
                    ),
                  )
                }
              />
              <Input
                aria-label="Port number"
                type="number"
                min={1024}
                max={65535}
                value={row.port}
                placeholder="Port"
                className="w-24 shrink-0"
                onChange={(event) =>
                  updateRows(
                    rows.map((currentRow) =>
                      currentRow.id === row.id
                        ? { ...currentRow, port: event.target.value }
                        : currentRow,
                    ),
                  )
                }
              />
              <Input
                aria-label="Initial path"
                className="grow"
                value={row.initial_path}
                placeholder="/"
                onChange={(event) =>
                  updateRows(
                    rows.map((currentRow) =>
                      currentRow.id === row.id
                        ? { ...currentRow, initial_path: event.target.value }
                        : currentRow,
                    ),
                  )
                }
              />
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.name || 'port'}`}
                  onClick={() =>
                    updateRows(
                      rows.filter((currentRow) => currentRow.id !== row.id),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {hiddenFields.map((hiddenField) => (
                <Badge key={hiddenField} variant="outline">
                  {hiddenField}
                </Badge>
              ))}
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          updateRows([
            ...rows,
            {
              id: makeId(),
              name: '',
              port: '3000',
              initial_path: '/',
              primary: false,
            },
          ])
        }
      >
        <Plus />
        Add
      </Button>
    </div>
  );
}
