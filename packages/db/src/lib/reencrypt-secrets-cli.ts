import { parseArgs } from 'node:util';

import { disconnect } from '../db';
import {
  reencryptSecrets,
  type LocationReport,
  type ReencryptSecretsReport,
} from './reencrypt-secrets';

const USAGE = `Usage: reencrypt-secrets [--dry-run] [--batch-size <n>] [--json]

Re-encrypts every stored secret with the current ENCRYPTION_KEY. Values that
only decrypt with ENCRYPTION_KEY_PREVIOUS are rewritten; values already on the
current key are left alone, so the command is safe to re-run.

Options:
  --dry-run          Report what would change without writing anything.
  --batch-size <n>   Rows read per query (default 200).
  --json             Print the report as JSON.
  -h, --help         Show this help.

Exit status is 1 when any row is unreadable with both keys or changed
concurrently during the run (re-run to retry those rows).`;

function formatRow(
  report: Omit<LocationReport, 'table' | 'column'>,
  name: string,
): string {
  if (report.skipped) {
    return `${name.padEnd(56)} skipped (${report.skipped})`;
  }
  return [
    name.padEnd(56),
    `scanned=${report.scanned}`,
    `current=${report.current}`,
    `migrated=${report.migrated}`,
    `unreadable=${report.unreadable}`,
    `not_encrypted=${report.notEncrypted}`,
    `conflicts=${report.conflicts}`,
    `remaining_on_previous=${report.remainingOnPreviousKey}`,
  ].join(' ');
}

function formatHeader(dryRun: boolean): string {
  return dryRun
    ? 'Dry run: no rows will be changed. "migrated" counts rows that would be rewritten.'
    : 'Re-encrypting stored secrets with the current ENCRYPTION_KEY.';
}

/** Totals plus next-step guidance, printed after the per-location rows. */
function formatSummary(report: ReencryptSecretsReport): string {
  const lines = [formatRow(report.totals, 'TOTAL'), ''];

  if (!report.previousKeyConfigured) {
    lines.push(
      'ENCRYPTION_KEY_PREVIOUS is not set, so no values can be migrated; rows encrypted with another key are reported as unreadable.',
    );
  }

  if (report.totals.unreadable > 0) {
    lines.push(
      `${report.totals.unreadable} row(s) decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS. They were left unchanged; re-save those secrets in Roomote or restore the key they were written with.`,
    );
  }

  if (report.totals.conflicts > 0) {
    lines.push(
      `${report.totals.conflicts} row(s) changed while the command ran and were skipped. Re-run the command to finish them.`,
    );
  }

  if (report.previousKeyConfigured) {
    if (report.remainingOnPreviousKey > 0) {
      lines.push(
        `Rows still on the previous key: ${report.remainingOnPreviousKey}. Keep ENCRYPTION_KEY_PREVIOUS set and ${report.dryRun ? 'run the command without --dry-run' : 'run the command again'}.`,
      );
    } else {
      lines.push(
        report.totals.unreadable > 0
          ? 'No rows remain on the previous key. ENCRYPTION_KEY_PREVIOUS can be removed; it does not open the unreadable rows either.'
          : 'No rows remain on the previous key. ENCRYPTION_KEY_PREVIOUS can be removed.',
      );
    }
  }

  return lines.join('\n');
}

export async function runReencryptSecretsCli(
  argv: readonly string[],
): Promise<number> {
  let values: {
    'dry-run'?: boolean;
    'batch-size'?: string;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'dry-run': { type: 'boolean' },
        'batch-size': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 64;
  }

  if (values.help) {
    console.info(USAGE);
    return 0;
  }

  const batchSize =
    values['batch-size'] === undefined
      ? undefined
      : Number(values['batch-size']);
  if (
    batchSize !== undefined &&
    (!Number.isInteger(batchSize) || batchSize < 1)
  ) {
    console.error('--batch-size must be a positive integer');
    return 64;
  }

  const dryRun = values['dry-run'] ?? false;

  try {
    if (!values.json) {
      console.info(`${formatHeader(dryRun)}\n`);
    }

    const report = await reencryptSecrets({
      dryRun,
      batchSize,
      onProgress: values.json
        ? undefined
        : (location) =>
            console.info(
              formatRow(location, `${location.table}.${location.column}`),
            ),
    });

    console.info(
      values.json
        ? JSON.stringify(report, null, 2)
        : `\n${formatSummary(report)}`,
    );

    return report.totals.unreadable > 0 || report.totals.conflicts > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `Re-encryption failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await disconnect().catch(() => undefined);
  }
}
