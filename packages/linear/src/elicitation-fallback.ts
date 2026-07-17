import {
  db,
  linearPendingSelections,
  repositories,
  environments,
  eq,
} from '@roomote/db/server';
import type { LinearPendingSelection } from '@roomote/db';
import { ALL_REPOSITORIES } from '@roomote/types';

import { LinearClient } from './linear-client';
import type { AgentSessionEventPayload } from './types';

/**
 * Duration for pending selection records (30 minutes)
 */
const PENDING_SELECTION_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Options for starting the elicitation fallback flow
 */
export interface StartElicitationFallbackOptions {
  sessionId: string;
  linearOrganizationId: string;
  userId: string | null;
  payload: AgentSessionEventPayload;
  linearClient: LinearClient;
}

/**
 * Result of starting the elicitation fallback flow
 */
export type StartElicitationFallbackResult =
  | { status: 'ok'; pendingSelection: LinearPendingSelection }
  | { status: 'error'; message: string };

/**
 * Options for handling an elicitation response
 */
export interface HandleElicitationResponseOptions {
  sessionId: string;
  responseText: string;
  linearClient: LinearClient;
}

/**
 * Result of handling an elicitation response
 */
export type HandleElicitationResponseResult =
  | {
      status: 'completed';
      repo: string;
      workspaceType: 'environment' | 'all';
      pendingSelection: LinearPendingSelection;
    }
  | { status: 'awaiting_workspace'; pendingSelection: LinearPendingSelection }
  | { status: 'error'; message: string }
  | { status: 'not_found' };

/**
 * Get available workspaces (environments and repositories) for the deployment
 */
type WorkspaceOption = {
  type: 'all' | 'environment';
  id: string;
  name: string;
};

async function getAvailableWorkspaces(): Promise<Array<WorkspaceOption>> {
  // Get environments
  const envs = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(eq(environments.isEval, false));

  // Get repositories
  const repos = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(eq(repositories.isActive, true));

  const workspaces: Array<{
    type: 'all' | 'environment';
    id: string;
    name: string;
  }> = [];

  // Add environments first (typically preferred)
  for (const env of envs) {
    workspaces.push({
      type: 'environment',
      id: env.id,
      name: `🖥️ ${env.name}`,
    });
  }

  // Add "All repos" option when repos exist
  if (repos.length > 0) {
    workspaces.push({
      type: 'all',
      id: ALL_REPOSITORIES,
      name: '📁 All repositories',
    });
  }

  return workspaces;
}

/**
 * Strips Unicode variation selectors (VS15 U+FE0E, VS16 U+FE0F) from a string.
 * These invisible characters control emoji presentation and differ across systems,
 * causing string comparison failures when one side includes them and the other doesn't.
 * For example, "🖥️" (U+1F5A5 + U+FE0F) vs "🖥" (U+1F5A5) would fail a naive comparison.
 */
export function stripVariationSelectors(str: string): string {
  return str.replace(/[\uFE0E\uFE0F]/g, '');
}

/**
 * Strips leading emoji characters and any following whitespace from a string.
 * Used to produce a plain-text version of option names that have decorative emoji
 * prefixes, e.g. "🖥️ app.roomote.example" → "app.roomote.example".
 */
export function stripEmojiPrefix(str: string): string {
  return str.replace(
    /^(?![0-9#*])[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u,
    '',
  );
}

/**
 * Strips markdown link syntax from a string, replacing [text](url) with just text.
 * Linear may return selections with markdown link formatting, e.g.
 * "[roomote.example](<http://roomote.example>)" → "roomote.example".
 */
function stripMarkdownLinks(str: string): string {
  let result = '';
  let index = 0;

  while (index < str.length) {
    if (str[index] === '[') {
      const closeBracket = str.indexOf(']', index + 1);
      if (
        closeBracket !== -1 &&
        closeBracket + 1 < str.length &&
        str[closeBracket + 1] === '('
      ) {
        const closeParen = str.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          result += str.slice(index + 1, closeBracket);
          index = closeParen + 1;
          continue;
        }
      }
    }

    result += str[index];
    index += 1;
  }

  return result;
}

/**
 * Normalizes a string for comparison by lowercasing, trimming, stripping
 * Unicode variation selectors, and stripping markdown link formatting.
 */
function normalizeForComparison(str: string): string {
  return stripMarkdownLinks(stripVariationSelectors(str.trim().toLowerCase()));
}

/**
 * Parse user selection from response text
 *
 * Supports formats:
 * - Just the option name: "Agent 1"
 * - Option name without emoji prefix: "app.roomote.example" (matches "🖥️ app.roomote.example")
 * - Number selection: "1" or "#1"
 * - Partial match: "agent" (matches "Agent 1" if only one match)
 *
 * All comparisons strip Unicode variation selectors (U+FE0F, U+FE0E) to handle
 * differences in emoji encoding across systems (e.g. Linear may return emoji
 * without variation selectors while we store them with).
 */
export function parseSelection(
  responseText: string,
  options: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const normalizedText = normalizeForComparison(responseText);

  // Try exact match first (with variation selectors stripped)
  const exactMatch = options.find(
    (opt) =>
      normalizeForComparison(opt.name) === normalizedText ||
      normalizeForComparison(opt.id) === normalizedText,
  );
  if (exactMatch) return exactMatch;

  // Try matching response text against option names with emoji prefix stripped.
  // This handles cases where the response is e.g. "app.roomote.example" and the
  // option name is "🖥️ app.roomote.example".
  const strippedText = stripEmojiPrefix(normalizedText);
  if (strippedText && strippedText !== normalizedText) {
    const strippedMatch = options.find(
      (opt) =>
        normalizeForComparison(opt.name) === strippedText ||
        normalizeForComparison(opt.id) === strippedText,
    );
    if (strippedMatch) return strippedMatch;
  }

  // Also try matching against option names that have their emoji prefix stripped.
  // This handles cases where the response includes the emoji but the comparison
  // should focus on the text portion.
  const emojiStrippedMatch = options.find(
    (opt) =>
      stripEmojiPrefix(normalizeForComparison(opt.name)) === normalizedText ||
      stripEmojiPrefix(normalizeForComparison(opt.name)) === strippedText,
  );
  if (emojiStrippedMatch) return emojiStrippedMatch;

  // Try number selection (e.g., "1" or "#1")
  const numberMatch = normalizedText.match(/^#?(\d+)$/);
  if (numberMatch?.[1]) {
    const index = parseInt(numberMatch[1], 10) - 1;
    if (index >= 0 && index < options.length) {
      return options[index] ?? null;
    }
  }

  // Try partial match (bidirectional: option contains text OR text contains option)
  const partialMatches = options.filter((opt) => {
    const normalizedName = normalizeForComparison(opt.name);
    const normalizedId = normalizeForComparison(opt.id);
    const strippedName = stripEmojiPrefix(normalizedName);
    return (
      normalizedName.includes(normalizedText) ||
      normalizedId.includes(normalizedText) ||
      normalizedText.includes(normalizedName) ||
      normalizedText.includes(normalizedId) ||
      (strippedText !== normalizedText &&
        (normalizedName.includes(strippedText) ||
          normalizedId.includes(strippedText))) ||
      (strippedName !== normalizedName && strippedName.includes(normalizedText))
    );
  });
  if (partialMatches.length === 1) {
    return partialMatches[0] ?? null;
  }

  return null;
}

/**
 * Start the elicitation fallback flow for workspace selection
 *
 * This is called when LLM routing is unavailable and we need to ask the user
 * to select a workspace for the standard delegated-task path.
 */
export async function startElicitationFallback({
  sessionId,
  linearOrganizationId,
  userId,
  payload,
  linearClient,
}: StartElicitationFallbackOptions): Promise<StartElicitationFallbackResult> {
  try {
    // Check if a pending selection already exists for this session
    // This handles duplicate webhook events from Linear
    const [existingPending] = await db
      .select()
      .from(linearPendingSelections)
      .where(eq(linearPendingSelections.sessionId, sessionId))
      .limit(1);

    if (existingPending) {
      console.log(
        `[elicitationFallback] Found existing pending selection for session ${sessionId}, step=${existingPending.step}`,
      );
      return { status: 'ok', pendingSelection: existingPending };
    }

    return startWorkspaceSelection({
      sessionId,
      linearOrganizationId,
      userId,
      payload,
      linearClient,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error starting flow';
    console.error(`[elicitationFallback] Error: ${message}`);
    return { status: 'error', message };
  }
}

/**
 * Start the workspace selection step for the standard delegated-task fallback path.
 */
async function startWorkspaceSelection({
  sessionId,
  linearOrganizationId,
  userId,
  payload,
  linearClient,
  existingPendingId,
}: {
  sessionId: string;
  linearOrganizationId: string;
  userId: string | null;
  payload: AgentSessionEventPayload;
  linearClient: LinearClient;
  existingPendingId?: string;
}): Promise<StartElicitationFallbackResult> {
  try {
    const workspaces = await getAvailableWorkspaces();

    // If there are no workspaces, use ALL_REPOSITORIES
    if (workspaces.length === 0) {
      const expiresAt = new Date(Date.now() + PENDING_SELECTION_EXPIRY_MS);

      let pendingSelection: LinearPendingSelection;

      if (existingPendingId) {
        const [updated] = await db
          .update(linearPendingSelections)
          .set({
            step: 'completed',
            selectedRepo: ALL_REPOSITORIES,
            updatedAt: new Date(),
          })
          .where(eq(linearPendingSelections.id, existingPendingId))
          .returning();
        pendingSelection = updated!;
      } else {
        const [created] = await db
          .insert(linearPendingSelections)
          .values({
            sessionId,
            linearOrganizationId,
            userId,
            step: 'completed',
            payload,
            selectedRepo: ALL_REPOSITORIES,
            expiresAt,
          })
          .returning();
        pendingSelection = created!;
      }

      return { status: 'ok', pendingSelection };
    }

    // If there's only one workspace, auto-select it
    if (workspaces.length === 1) {
      const workspace = workspaces[0]!;
      const expiresAt = new Date(Date.now() + PENDING_SELECTION_EXPIRY_MS);

      let pendingSelection: LinearPendingSelection;

      if (existingPendingId) {
        const [updated] = await db
          .update(linearPendingSelections)
          .set({
            step: 'completed',
            selectedRepo: workspace.id,
            workspaceOptions: workspaces,
            updatedAt: new Date(),
          })
          .where(eq(linearPendingSelections.id, existingPendingId))
          .returning();
        pendingSelection = updated!;
      } else {
        const [created] = await db
          .insert(linearPendingSelections)
          .values({
            sessionId,
            linearOrganizationId,
            userId,
            step: 'completed',
            payload,
            selectedRepo: workspace.id,
            workspaceOptions: workspaces,
            expiresAt,
          })
          .returning();
        pendingSelection = created!;
      }

      return { status: 'ok', pendingSelection };
    }

    // Multiple workspaces - ask the user
    const expiresAt = new Date(Date.now() + PENDING_SELECTION_EXPIRY_MS);

    let pendingSelection: LinearPendingSelection;

    if (existingPendingId) {
      const [updated] = await db
        .update(linearPendingSelections)
        .set({
          step: 'awaiting_workspace',
          workspaceOptions: workspaces,
          updatedAt: new Date(),
        })
        .where(eq(linearPendingSelections.id, existingPendingId))
        .returning();
      pendingSelection = updated!;
    } else {
      const [created] = await db
        .insert(linearPendingSelections)
        .values({
          sessionId,
          linearOrganizationId,
          userId,
          step: 'awaiting_workspace',
          payload,
          workspaceOptions: workspaces,
          expiresAt,
        })
        .returning();
      pendingSelection = created!;
    }

    // Build the workspace selection message
    const workspaceList = workspaces
      .map((ws, index) => `${index + 1}. ${ws.name}`)
      .join('\n');

    const message = `In which workspace?\n\n${workspaceList}`;

    // Emit the elicitation with select signal
    const result = await linearClient.emitElicitation(sessionId, message, {
      signal: 'select',
      signalMetadata: {
        options: workspaces.map((ws) => ({ value: ws.name })),
      },
    });

    if (!result.success) {
      console.error(
        `[elicitationFallback] Failed to emit workspace selection elicitation: ${result.error}`,
      );
      return { status: 'error', message: result.error ?? 'Unknown error' };
    }

    console.log(
      `[elicitationFallback] Started workspace selection for session ${sessionId}`,
    );

    return { status: 'ok', pendingSelection };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error starting workspace selection';
    console.error(`[elicitationFallback] Error: ${message}`);
    return { status: 'error', message };
  }
}

/**
 * Find a pending selection for a session
 */
export async function findPendingSelection(
  sessionId: string,
): Promise<LinearPendingSelection | null> {
  // Actually, let's do a simpler query
  const [result] = await db
    .select()
    .from(linearPendingSelections)
    .where(eq(linearPendingSelections.sessionId, sessionId))
    .limit(1);

  if (!result) return null;

  // Check if expired
  if (new Date() > result.expiresAt) {
    // Clean up expired record
    await db
      .delete(linearPendingSelections)
      .where(eq(linearPendingSelections.id, result.id));
    return null;
  }

  // Only return if still awaiting
  if (result.step === 'completed') {
    return null;
  }

  return result;
}

/**
 * Handle a user response to an elicitation
 */
export async function handleElicitationResponse({
  sessionId,
  responseText,
  linearClient,
}: HandleElicitationResponseOptions): Promise<HandleElicitationResponseResult> {
  try {
    // Find the pending selection
    const pendingSelection = await findPendingSelection(sessionId);

    if (!pendingSelection) {
      return { status: 'not_found' };
    }

    if (pendingSelection.step === 'awaiting_workspace') {
      // Parse the workspace selection
      const workspaceOptions =
        (pendingSelection.workspaceOptions as WorkspaceOption[] | null) ?? [];
      const selectedWorkspace = parseSelection(responseText, workspaceOptions);

      if (!selectedWorkspace) {
        console.warn(
          `[elicitationFallback] Failed to match workspace selection. User entered: ${JSON.stringify(responseText)}, options: ${JSON.stringify(workspaceOptions.map((ws) => ({ id: ws.id, name: ws.name })))}`,
        );
        // Couldn't parse - ask again
        const workspaceList = workspaceOptions
          .map((ws, index) => `${index + 1}. ${ws.name}`)
          .join('\n');

        await linearClient.emitElicitation(
          sessionId,
          `I didn't understand that selection. Please choose a workspace:\n\n${workspaceList}`,
          {
            signal: 'select',
            signalMetadata: {
              options: workspaceOptions.map((ws) => ({ value: ws.name })),
            },
          },
        );

        return {
          status: 'awaiting_workspace',
          pendingSelection,
        };
      }

      // Look up the full workspace option to get the type
      const matchedOption = workspaceOptions.find(
        (ws) => ws.id === selectedWorkspace.id,
      );
      const workspaceType: 'environment' | 'all' = matchedOption?.type ?? 'all';

      console.log(
        `[elicitationFallback] User selected workspace: ${selectedWorkspace.name} (type: ${workspaceType})`,
      );

      // Mark as completed
      const [updated] = await db
        .update(linearPendingSelections)
        .set({
          step: 'completed',
          selectedRepo: selectedWorkspace.id,
          updatedAt: new Date(),
        })
        .where(eq(linearPendingSelections.id, pendingSelection.id))
        .returning();

      return {
        status: 'completed',
        repo: selectedWorkspace.id,
        workspaceType,
        pendingSelection: updated!,
      };
    }

    return { status: 'not_found' };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error handling response';
    console.error(`[elicitationFallback] Error: ${message}`);
    return { status: 'error', message };
  }
}

/**
 * Delete a pending selection
 */
export async function deletePendingSelection(sessionId: string): Promise<void> {
  await db
    .delete(linearPendingSelections)
    .where(eq(linearPendingSelections.sessionId, sessionId));
}
