'use client';

import { COMMAND_DEFAULT_TIMEOUT, type Command } from '@roomote/types';

import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Plus,
  Slider,
  Textarea,
  Trash2,
} from '@/components/system';

import { FieldShell } from './VisualEnvironmentEditor.layout';
import {
  commandsToRows,
  makeId,
  normalizeCommands,
  serializeCommands,
  type CommandRow,
} from './VisualEnvironmentEditor.model';
import { useEditableRows } from './useEditableRows';

const TIMEOUT_SLIDER_MIN_SECONDS = 5;
const TIMEOUT_SLIDER_MAX_SECONDS = COMMAND_DEFAULT_TIMEOUT;
const TIMEOUT_SLIDER_STEP_SECONDS = 5;

function getTimeoutSliderValue(value: string) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return TIMEOUT_SLIDER_MAX_SECONDS;
  }

  const roundedToStep =
    Math.round(numericValue / TIMEOUT_SLIDER_STEP_SECONDS) *
    TIMEOUT_SLIDER_STEP_SECONDS;

  return Math.min(
    TIMEOUT_SLIDER_MAX_SECONDS,
    Math.max(TIMEOUT_SLIDER_MIN_SECONDS, roundedToStep),
  );
}

export function CommandListEditor({
  commands,
  onChange,
}: {
  commands?: Command[];
  onChange: (next: Command[] | undefined) => void;
}) {
  const { rows, updateRows } = useEditableRows<
    CommandRow,
    Command[] | undefined
  >({
    value: commands,
    onChange,
    valueToRows: commandsToRows,
    rowsToValue: normalizeCommands,
    serializeValue: serializeCommands,
  });

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
          No commands
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="divide-y pt-2.25">
          {rows.map((row) => {
            const hiddenFields = [
              row.cwd ? 'cwd' : null,
              row.working_dir ? 'working dir' : null,
              row.retries !== undefined ? 'retries' : null,
              row.env && Object.keys(row.env).length > 0 ? 'env' : null,
            ].filter((value): value is string => Boolean(value));

            return (
              <div key={row.id} className="space-y-4 py-4 first:pt-0">
                <div className="space-y-3">
                  <FieldShell>
                    <div className="flex items-center justify-between gap-2">
                      <Label>Command</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${row.name || 'command'}`}
                        className="shrink-0"
                        onClick={() =>
                          updateRows(
                            rows.filter(
                              (currentRow) => currentRow.id !== row.id,
                            ),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <Textarea
                      aria-label="Command run"
                      value={row.run}
                      placeholder="Command"
                      rows={1}
                      className="min-h-9 resize-y overflow-y-auto font-mono [field-sizing:fixed]"
                      onChange={(event) =>
                        updateRows(
                          rows.map((currentRow) =>
                            currentRow.id === row.id
                              ? { ...currentRow, run: event.target.value }
                              : currentRow,
                          ),
                        )
                      }
                    />
                  </FieldShell>
                  <FieldShell>
                    <Label>Description</Label>
                    <Input
                      aria-label="Command description"
                      value={row.name}
                      placeholder="Description"
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
                  </FieldShell>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.2fr)_auto] lg:items-end">
                  <FieldShell>
                    <Label>Timeout (s)</Label>
                    <div className="flex w-full items-center gap-3">
                      <Input
                        aria-label="Timeout seconds"
                        type="number"
                        value={row.timeout}
                        placeholder="Timeout"
                        className="w-20 shrink-0"
                        onChange={(event) =>
                          updateRows(
                            rows.map((currentRow) =>
                              currentRow.id === row.id
                                ? {
                                    ...currentRow,
                                    timeout: event.target.value,
                                  }
                                : currentRow,
                            ),
                          )
                        }
                      />
                      <Slider
                        aria-label="Timeout seconds slider"
                        min={TIMEOUT_SLIDER_MIN_SECONDS}
                        max={TIMEOUT_SLIDER_MAX_SECONDS}
                        step={TIMEOUT_SLIDER_STEP_SECONDS}
                        value={[getTimeoutSliderValue(row.timeout)]}
                        onValueChange={([nextValue]) =>
                          updateRows(
                            rows.map((currentRow) =>
                              currentRow.id === row.id
                                ? {
                                    ...currentRow,
                                    timeout: String(
                                      nextValue ?? TIMEOUT_SLIDER_MAX_SECONDS,
                                    ),
                                  }
                                : currentRow,
                            ),
                          )
                        }
                      />
                    </div>
                  </FieldShell>

                  <FieldShell>
                    <Label>Logfile path (optional)</Label>
                    <Input
                      aria-label="Command logfile"
                      value={row.logfile ?? ''}
                      placeholder="path/to/logfile.log"
                      className="font-mono"
                      onChange={(event) =>
                        updateRows(
                          rows.map((currentRow) =>
                            currentRow.id === row.id
                              ? {
                                  ...currentRow,
                                  logfile: event.target.value,
                                }
                              : currentRow,
                          ),
                        )
                      }
                    />
                  </FieldShell>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Checkbox
                      checked={row.detached}
                      onCheckedChange={(checked) =>
                        updateRows(
                          rows.map((currentRow) =>
                            currentRow.id === row.id
                              ? { ...currentRow, detached: checked === true }
                              : currentRow,
                          ),
                        )
                      }
                    />
                    <span>Run in the background</span>
                  </label>

                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Checkbox
                      checked={row.continue_on_error}
                      onCheckedChange={(checked) =>
                        updateRows(
                          rows.map((currentRow) =>
                            currentRow.id === row.id
                              ? {
                                  ...currentRow,
                                  continue_on_error: checked === true,
                                }
                              : currentRow,
                          ),
                        )
                      }
                    />
                    <span>Don&apos;t block setup even if it fails</span>
                  </label>
                </div>

                {hiddenFields.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {hiddenFields.map((hiddenField) => (
                      <Badge key={hiddenField} variant="outline">
                        {hiddenField}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

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
              run: '',
              timeout: String(COMMAND_DEFAULT_TIMEOUT),
              detached: false,
              continue_on_error: false,
            },
          ])
        }
      >
        <Plus />
        Add command
      </Button>
    </div>
  );
}
