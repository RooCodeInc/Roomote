export interface ConflictResolutionSummary {
  resolvedFiles: string[];
  controversialDecisions: string[];
  warnings: string[];
}

export const CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY =
  'conflictResolutionSummary' as const;

function normalizeBulletValue(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (/^none$/i.test(trimmed)) {
    return null;
  }

  const backtickMatch = /^`([^`]+)`$/.exec(trimmed);

  return backtickMatch?.[1]?.trim() || trimmed;
}

export function parseConflictResolutionSummary(
  text: string,
): ConflictResolutionSummary | null {
  const trimmedText = text.trim();

  if (!trimmedText.startsWith('Resolved merge conflicts')) {
    return null;
  }

  const summary: ConflictResolutionSummary = {
    resolvedFiles: [],
    controversialDecisions: [],
    warnings: [],
  };

  let section: keyof ConflictResolutionSummary | null = null;

  for (const rawLine of trimmedText.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (line === 'Resolved merge conflicts in:' || line === 'RESOLVED_FILES:') {
      section = 'resolvedFiles';
      continue;
    }

    if (
      line === "Decisions I'm not 100% sure:" ||
      line === 'CONTROVERSIAL_DECISIONS:'
    ) {
      section = 'controversialDecisions';
      continue;
    }

    if (line === 'Warnings:' || line === 'WARNINGS:') {
      section = 'warnings';
      continue;
    }

    if (!line.startsWith('- ')) {
      continue;
    }

    const value = normalizeBulletValue(line.slice(2));

    if (!value || !section) {
      continue;
    }

    summary[section].push(value);
  }

  return summary;
}

export function readConflictResolutionSummary(
  value: unknown,
): ConflictResolutionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidate = record[CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY];

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const nested = candidate as Record<string, unknown>;

  const resolvedFiles = Array.isArray(nested.resolvedFiles)
    ? nested.resolvedFiles.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const controversialDecisions = Array.isArray(nested.controversialDecisions)
    ? nested.controversialDecisions.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const warnings = Array.isArray(nested.warnings)
    ? nested.warnings.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    resolvedFiles,
    controversialDecisions,
    warnings,
  };
}

export function formatConflictResolutionSuccessComment(
  summary: ConflictResolutionSummary,
): string {
  const lines: string[] = [];

  if (summary.resolvedFiles.length > 0) {
    lines.push('Resolved merge conflicts in:');

    for (const file of summary.resolvedFiles) {
      lines.push(`- \`${file}\``);
    }

    lines.push('');
  } else {
    lines.push('Resolved merge conflicts.');
    lines.push('');
  }

  if (summary.controversialDecisions.length > 0) {
    lines.push("Decisions I'm not 100% sure:");

    for (const decision of summary.controversialDecisions) {
      lines.push(`- ${decision}`);
    }

    lines.push('');
  }

  if (summary.warnings.length > 0) {
    lines.push('Warnings:');

    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

export function formatConflictResolutionFailureComment(reason: string): string {
  return [
    'I detected merge conflicts but could not automatically resolve them:',
    reason,
  ].join('\n');
}
