import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSuggestedTasksPrompt } from '../suggested-tasks-prompt';

describe('buildSuggestedTasksPrompt', () => {
  it('includes the exploration-first direct OpenCode investigation guidance', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
    });

    expect(prompt).toContain(
      'Start by scanning the structure of each repository - directory layout, package boundaries, app surfaces, API entry points, integration handlers, and other major subsystem seams',
    );
    expect(prompt).toContain('Repositories:\n- acme/web');
    expect(prompt).toContain(
      'Use repo structure, user-facing importance, operator impact, and any setup guidance the user provided to decide where to investigate first.',
    );
    expect(prompt).toContain(
      'Also review recent activity on each repository - merged pull requests, recent commits on the default branch, and any open PRs',
    );
    expect(prompt).toContain(
      'Use the available GitHub MCP tools to inspect that activity yourself.',
    );
    expect(prompt).toContain(
      'Treat recent activity as a secondary signal for targeted follow-up investigations, not as the primary source of every investigation thread.',
    );
    expect(prompt).toContain('Do not limit yourself to recently changed code.');
    expect(prompt).toContain(
      'code quality and maintainability issues: overly complex functions, duplicated logic, poor abstractions, dead code, or confusing structure that is likely to slow the team down or cause real problems',
    );
    expect(prompt).toContain(
      'exploration mode is primary. Most investigation time should go to open-ended exploration of important areas or subsystems.',
    );
    expect(prompt).toContain(
      'recent-activity mode is secondary. Reserve a small part of the run for hypothesis-driven follow-ups to recent PRs, commits, or open PRs.',
    );
    expect(prompt).toContain(
      'aim for roughly 6-8 exploration threads across different subsystems or areas and roughly 1-2 recent-activity follow-ups.',
    );
    expect(prompt).toContain(
      'investigate directly in the active OpenCode session. Do not spawn child agent processes or depend on another CLI.',
    );
    expect(prompt).toContain(
      'collect candidate findings as you go, but do not submit until you have reviewed all selected investigation threads.',
    );
    expect(prompt).toContain(
      'for each candidate finding, record the repository, file paths, relevant functions or variables, the failure mechanism, a concrete repro or user-impact scenario, and a confidence level.',
    );
    expect(prompt).not.toContain(
      'Only use a repository when you find recent activity evidence within the last 90 days.',
    );
    expect(prompt).not.toContain('Selected repositories:');
    expect(prompt).toContain('RANKING PHASE (mandatory, after investigation):');
    expect(prompt).toContain(
      'rank all candidate findings together in a single pass.',
    );
    expect(prompt).toContain(
      'your role is investigator and editor: identify what is worth checking, inspect the code, verify the evidence, then decide which findings meet the bar.',
    );
    expect(prompt).not.toContain('legacy-cli');
    expect(prompt).not.toContain('/tmp/legacy-investigation-schema.json');
    expect(prompt).toContain(
      'Structural code quality findings are welcome when they address genuinely confusing, fragile, or overly complex code - not cosmetic preferences.',
    );
    expect(prompt).toContain(
      'Every suggestion must be attributable to exactly one repository.',
    );
    expect(prompt).toContain(
      'Each `brief` must stay within 2-3 sentences and include one concrete example scenario showing how the issue manifests in practice.',
    );
    expect(prompt).toContain(
      "`priority`: one of 'P0', 'P1', 'P2', or 'P3'. Classify based on severity and user impact:",
    );
    expect(prompt).toContain(
      'P0: actively breaking user-facing functionality or causing data loss',
    );
    expect(prompt).toContain(
      '`investigationContext`: detailed implementation evidence for the agent who will fix it, capped at 4000 characters.',
    );
    expect(prompt).toContain(
      'This field is hidden from Slack users and only passed to the implementing agent.',
    );
    expect(prompt).toContain(
      '`targetRepositoryFullName`: the single repository that owns the idea',
    );
    expect(prompt).toContain(
      '`targetEnvironmentId`: include this when the repository environment list provides one for that repository',
    );
    expect(prompt).toContain(
      'Use the repository environment list only to copy the matching `targetEnvironmentId` onto suggestions for that repository when one is listed.',
    );
    expect(prompt).not.toContain('environment-backed execution relevance');
    expect(prompt).not.toContain(
      'Prefer repositories that already have environment coverage.',
    );
    expect(prompt).not.toContain(
      'Rank environment_backed suggestions ahead of bare_repo suggestions.',
    );
  });

  it('sorts repository names alphabetically', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['zeta/api', 'alpha/web', 'beta/worker'],
      setupGuidance: null,
      suggesterInstructions: null,
    });

    expect(prompt.indexOf('- alpha/web')).toBeLessThan(
      prompt.indexOf('- beta/worker'),
    );
    expect(prompt.indexOf('- beta/worker')).toBeLessThan(
      prompt.indexOf('- zeta/api'),
    );
  });

  it('includes optional sections when provided and omits them when blank', () => {
    const withSections = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance:
        '  Install Redis before reproducing background job issues.  ',
      suggesterInstructions:
        '  Prefer operator-facing issues over internal cleanup.  ',
    });

    expect(withSections).toContain(
      'Additional setup context from the user:\nInstall Redis before reproducing background job issues.',
    );
    expect(withSections).toContain(
      'Custom suggestion preferences from the user:\nPrefer operator-facing issues over internal cleanup.',
    );

    const withoutSections = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: '   ',
      suggesterInstructions: null,
    });

    expect(withoutSections).not.toContain(
      'Additional setup context from the user:',
    );
    expect(withoutSections).not.toContain(
      'Custom suggestion preferences from the user:',
    );
  });

  it('includes repository coverage details when provided', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/api', 'acme/worker'],
      repositoryCoverage: [
        {
          repositoryFullName: 'acme/api',
          targetEnvironmentId: 'env-1',
        },
        {
          repositoryFullName: 'acme/worker',
        },
      ],
      setupGuidance: null,
      suggesterInstructions: null,
    });

    expect(prompt).toContain(
      'Repository environments:\n- acme/api -> environment env-1',
    );
    expect(prompt).not.toContain('acme/worker -> no environment');
  });

  it('omits the repository environments section when no environment-backed repos are provided', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/worker'],
      repositoryCoverage: [
        {
          repositoryFullName: 'acme/worker',
        },
      ],
      setupGuidance: null,
      suggesterInstructions: null,
    });

    expect(prompt).not.toContain('Repository environments:');
  });

  it('includes previous suggestions section when provided', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
      previousSuggestions: [
        {
          title: 'Scope legacy run tokens to their own task',
          brief: 'Legacy run tokens can still reach unrelated task APIs.',
          status: 'open',
        },
        {
          title: 'Sign Slack OAuth state to the initiating org',
          brief:
            'Slack install state is accepted without binding it to the org that started the flow.',
          status: 'dismissed',
        },
      ],
    });

    expect(prompt).toContain(
      'Previously suggested ideas (status shows whether each suggestion is still open, was already launched, or was dismissed; do NOT re-suggest open or launched ideas, and avoid repeating dismissed ones):',
    );
    expect(prompt).toContain(
      '[open] Scope legacy run tokens to their own task',
    );
    expect(prompt).toContain(
      '[dismissed] Sign Slack OAuth state to the initiating org',
    );
  });

  it('omits previous suggestions section when list is empty', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
      previousSuggestions: [],
    });

    expect(prompt).not.toContain('Previously suggested ideas');
  });

  it('includes recent Slack thread feedback when provided', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
      recentThreadFeedback:
        '- 2026-04-02 summary: Suggestions were too clustered in auth\n  Team feedback:\n  - Include more operator-facing cleanup work',
    });

    expect(prompt).toContain('Recent feedback from earlier suggestion threads');
    expect(prompt).toContain('Suggestions were too clustered in auth');
    expect(prompt).toContain('Include more operator-facing cleanup work');
  });

  it('truncates long briefs in previous suggestions', () => {
    const longBrief = 'a'.repeat(300);
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
      previousSuggestions: [
        {
          title: 'Repeated idea',
          brief: longBrief,
          status: 'launched',
        },
      ],
    });

    expect(prompt).toContain(`[launched] Repeated idea: ${'a'.repeat(200)}...`);
    expect(prompt).not.toContain(`[launched] Repeated idea: ${longBrief}`);
  });

  it('includes category diversity and expanded suggestion sources', () => {
    const prompt = buildSuggestedTasksPrompt({
      repositoryFullNames: ['acme/web'],
      setupGuidance: null,
      suggesterInstructions: null,
    });

    expect(prompt).toContain('aim for a diverse mix across categories');
    expect(prompt).toContain('CATEGORY DIVERSITY (mandatory)');
    expect(prompt).toContain(
      'the final set of 5 suggestions must include at least 2 different categories',
    );
    expect(prompt).toContain('developer experience improvements');
    expect(prompt).toContain('performance opportunities');
    expect(prompt).toContain('missing or incomplete functionality');
    expect(prompt).toContain('test gaps');
    expect(prompt).toContain('observability and operational improvements');
  });

  it('preserves the template interpolation slots in source', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const promptPath = path.resolve(
      thisDirPath,
      '../suggested-tasks-prompt.ts',
    );
    const promptSource = fs.readFileSync(promptPath, 'utf8');

    expect(promptSource).toContain('${repositoryLines}');
    expect(promptSource).toContain('${repositoryCoverageSection}');
    expect(promptSource).toContain('${setupGuidanceSection}');
    expect(promptSource).toContain('${suggesterInstructionsSection}');
    expect(promptSource).toContain('${previousSuggestionsSection}');
    expect(promptSource).toContain('${recentThreadFeedbackSection}');
  });
});
