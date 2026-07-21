/**
 * Humanizes an automation key for display, e.g. `pr_review` -> "PR Review",
 * `mcp_recommendations` -> "MCP Recommendations". Shared across the web
 * dashboard/analytics and server-side stats so automation labels stay
 * consistent wherever an automation key is surfaced to a human.
 *
 * For `custom_automation`, prefer the user-entered automation name stamped on
 * the task as `actorDisplayName` when provided.
 */
const AUTOMATION_LABEL_ACRONYMS = new Set(['pr', 'ci', 'mcp']);

/** Full-key spellings when token title-casing would not match the product label. */
const AUTOMATION_LABEL_KEY_OVERRIDES = new Map([
  ['issue_fixer', 'Triage Issues'],
  ['custom_automation', 'Custom'],
]);

/** Token spellings that are not plain UPPERCASE acronyms. */
const AUTOMATION_LABEL_TOKEN_OVERRIDES = new Map([['codeql', 'CodeQL']]);

export type AutomationLabelOptions = {
  /**
   * User-entered custom automation name when `key` is `custom_automation`.
   * Ignored for fixed-catalog automation keys.
   */
  actorDisplayName?: string | null;
};

function resolveCustomAutomationDisplayName(
  options?: AutomationLabelOptions,
): string | null {
  const name = options?.actorDisplayName?.trim();
  return name ? name : null;
}

export function formatAutomationLabel(
  key: string,
  options?: AutomationLabelOptions,
): string {
  if (key === 'custom_automation') {
    const customName = resolveCustomAutomationDisplayName(options);
    if (customName) {
      return customName;
    }
  }

  const keyOverride = AUTOMATION_LABEL_KEY_OVERRIDES.get(key);
  if (keyOverride) {
    return keyOverride;
  }

  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => {
      const override = AUTOMATION_LABEL_TOKEN_OVERRIDES.get(word);
      if (override) return override;
      return AUTOMATION_LABEL_ACRONYMS.has(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Task-owner attribution for automation-created work.
 * Prefer "{name} Automation" so the owner reads as work done by an automation,
 * not as a separate agent identity.
 *
 * For user-defined custom automations, `{name}` is the user-entered automation
 * name when available (e.g. "Weekly flaky-test scan Automation").
 */
export function formatAutomationAttributionLabel(
  key: string,
  options?: AutomationLabelOptions,
): string {
  const name = formatAutomationLabel(key, options);
  return name ? `${name} Automation` : '';
}
