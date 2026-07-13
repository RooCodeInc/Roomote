import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readSkill(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('PR description prompt scope', () => {
  it('keeps the Roomote repository template aligned with the fallback reviewer contract', () => {
    const roomoteTemplate = fs.readFileSync(
      path.resolve(
        thisDirPath,
        '../../../../../../.github/PULL_REQUEST_TEMPLATE.md',
      ),
      'utf8',
    );

    expect(roomoteTemplate).toContain('## What problem this solves');
    expect(roomoteTemplate).toContain('## Why this change was made');
    expect(roomoteTemplate).toContain('## User impact');
    expect(roomoteTemplate).toContain('## Evidence');
    expect(roomoteTemplate).toContain('## Contribution status');
    expect(roomoteTemplate).toContain(
      'I personally posted the exact signature comment specified in `CLA.md`',
    );
    expect(roomoteTemplate).toContain(
      "Agents must not post that legal attestation on the contributor's",
    );
    expect(roomoteTemplate).toContain(
      'The PR title follows the repo convention: `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`',
    );
    expect(roomoteTemplate).not.toContain('## What changed');
    expect(roomoteTemplate).not.toContain('## How it was tested');
  });

  it('defines one canonical PR-writing contract and keeps child skills reference-only', () => {
    const implementSkill = readSkill(
      '../skills/standard/implement-changes/SKILL.md',
    );
    const childSkills = [
      readSkill('../skills/standard/create-pr/SKILL.md'),
      readSkill('../skills/standard/create-draft-pr/SKILL.md'),
      readSkill('../skills/standard/fix-pr/SKILL.md'),
    ];
    const contractMatches = implementSkill.match(
      /<pr_writing_contract id="pr-writing-contract">[\s\S]*?<\/pr_writing_contract>/g,
    );

    expect(contractMatches).toHaveLength(1);
    expect(contractMatches![0]).toContain(
      'Use conversation context only when it still matches the final shipped diff.',
    );
    expect(contractMatches![0]).toContain(
      "Follow the selected template's explicit title convention. Otherwise use exactly one of `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`",
    );
    expect(contractMatches![0]).toContain(
      '<section name="What problem this solves">',
    );
    expect(contractMatches![0]).toContain('<section name="Evidence">');
    expect(contractMatches![0]).toContain(
      'State failed, skipped, or unavailable checks honestly.',
    );
    expect(contractMatches![0]).toContain(
      "Never post a personal legal attestation on the contributor's behalf.",
    );
    expect(contractMatches![0]).toContain(
      'Treat failure as a hard gate: rewrite the metadata and re-check it before the source-control mutation.',
    );
    expect(implementSkill).not.toContain('<pr-writing-guide>');

    for (const childSkill of childSkills) {
      expect(childSkill).toContain('inherited `pr-writing-contract`');
      expect(childSkill).toContain(
        "do not duplicate or override the contract's title, body, or gate rules locally.",
      );
      expect(childSkill).not.toContain('<pr-writing-guide>');
      expect(childSkill).not.toContain('<pr_writing_contract');
    }
  });

  it('keeps delivery skills aligned on the shared PR metadata update recipe', () => {
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const fixPrSkill = readSkill('../skills/standard/fix-pr/SKILL.md');

    const recipeBlockPattern =
      /<pr-metadata-update-recipe>[\s\S]*?<\/pr-metadata-update-recipe>/;
    const createPrRecipe = createPrSkill.match(recipeBlockPattern);
    const createDraftPrRecipe = createDraftPrSkill.match(recipeBlockPattern);
    const fixPrRecipe = fixPrSkill.match(recipeBlockPattern);

    expect(createPrRecipe).not.toBeNull();
    expect(createDraftPrRecipe).not.toBeNull();
    expect(fixPrRecipe).not.toBeNull();
    expect(createPrRecipe![0]).not.toBe(createDraftPrRecipe![0]);

    expect(fixPrSkill).toContain(
      'When an open pull request exists, capture the full shipped diff for the branch locally with `git fetch origin',
    );
    expect(fixPrSkill).toContain(
      'recover existing PR-body metadata that still applies, including current `## Related PRs` links, from the `body` field of the latest `get_pull_request` result.',
    );
    expect(createPrSkill).toContain(
      'HEAD` to capture the full shipped diff for the branch. Use this local git diff for every provider.',
    );
    expect(createPrSkill).toContain(
      'When an earlier delivery pass in this task produced a `/tmp/pr-body.md`, read it before overwriting it so still-applicable metadata can be recovered, including current `## Related PRs` links, `## Linked work items`, and proof sections; this workflow does not read the remote pull request body.',
    );

    for (const skillContent of [createPrSkill, fixPrSkill]) {
      expect(skillContent).toContain(
        'Call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "get_messages"` for the current task using `limit: 20`.',
      );
      expect(skillContent).toContain(
        'Reverse the returned newest-first message list before extracting the original problem statement, motivation, and key decisions from the conversation history.',
      );
      if (skillContent === fixPrSkill) {
        expect(skillContent).toContain(
          "Before writing `/tmp/pr-body.md`, check for a checked-in repository pull request or merge request template in the locations the repository's source-control provider supports.",
        );
        expect(skillContent).toContain(
          'Write `/tmp/pr-body.md` from the shipped diff and recovered conversation under the inherited `pr-writing-contract`.',
        );
      } else {
        expect(skillContent).toContain(
          'Write `/tmp/pr-body.md` from the shipped diff, recovered conversation, and still-applicable metadata under the inherited `pr-writing-contract`.',
        );
      }
      if (skillContent === fixPrSkill) {
        expect(skillContent).toContain(
          'When the latest `get_pull_request` result confirms the pull request is open, refresh it with `mcp__roomote__manage_source_control` `action: "create_or_update_pull_request"`',
        );
        expect(skillContent).toContain(
          "The refresh never flips draft status: the platform preserves the pull request's existing draft state on update.",
        );
      }
      if (skillContent === fixPrSkill) {
        expect(skillContent).toContain(
          'Preserve only still-applicable metadata from the current PR body: the caller-supplied PR provenance block as the opening blockquote, `## Related PRs` links identified by the current PR body or task context, and current valid proof artifact sections.',
        );
      } else {
        expect(skillContent).toContain(
          'Preserve or refresh `## Related PRs` when the previous `/tmp/pr-body.md` or current task context identifies sibling PRs.',
        );
        expect(skillContent).toContain(
          'Preserve or refresh `## Linked work items` when the previous `/tmp/pr-body.md` or current workflow instructions identify linked work items.',
        );
        expect(skillContent).toContain(
          'include that block verbatim and do not rewrite provider-specific closing or reference syntax.',
        );
      }
      if (skillContent === fixPrSkill) {
        expect(skillContent).toContain(
          'When the latest `capture-visual-proof` handoff reports an uploaded artifact list from `manage_artifacts` upload results, treat it as the authoritative visual-proof input. Visual proof sections are only `## Screenshots` and `## Screencasts` when current artifact links exist. Render screenshots from the reported screenshots only when present, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body; do not create `## Visual proof` for screenshots and do not render screenshot artifact viewer links when `rawUrl` exists. Render screencasts from the reported screencasts only when present',
        );
      } else {
        expect(skillContent).toContain(
          'When the latest `capture-visual-proof` handoff reports an uploaded artifact list from `manage_artifacts` upload results, treat it as the authoritative visual-proof input: render `## Screenshots` from its reported screenshots only when present, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body; do not create `## Visual proof` for screenshots and do not render screenshot artifact viewer links when `rawUrl` exists; render `## Screencasts` from its reported screencasts only when present',
        );
      }
      expect(skillContent).toContain(
        '[![<clip-name>](<first-keyframe-rawUrl>)](<video-viewUrl>)',
      );
      expect(skillContent).toContain(
        "where `<video-viewUrl>` is the clip's uploaded `viewUrl`",
      );
      expect(skillContent).not.toContain('<poster-rawUrl>');
      expect(skillContent).not.toContain('githubAttachmentUrl');
      if (skillContent === fixPrSkill) {
        expect(skillContent).toContain(
          'Remove any existing `## Screenshots` or `## Screencasts` section whose latest reported set is empty so stale evidence is not preserved.',
        );
        expect(skillContent).toContain(
          'When that uploaded artifact list does not exist and the latest proof handoff is an honest no-op result because this cycle did not run `capture-visual-proof`, preserve existing `## Screenshots` and `## Screencasts` sections only when they already contain valid artifact URLs or screencast embeds.',
        );
        expect(skillContent).toContain(
          'When the latest proof handoff reports that browser proof is not applicable, unnecessary, or blocked, remove existing `## Screenshots` and `## Screencasts` sections instead of preserving stale proof from an earlier cycle.',
        );
      } else {
        expect(skillContent).toContain(
          'explicitly remove any existing `## Screenshots` or `## Screencasts` section whose latest reported set is empty so stale evidence is not preserved.',
        );
        expect(skillContent).toContain(
          'When that uploaded artifact list does not exist and the latest proof handoff is an honest no-op result because this cycle did not run `capture-visual-proof`, preserve any existing `## Screenshots` and `## Screencasts` sections from the previous `/tmp/pr-body.md` when they already contain valid artifact URLs or screencast embeds.',
        );
        expect(skillContent).toContain(
          'When that uploaded artifact list does not exist and the latest proof handoff reports that browser proof is not applicable, that screenshots and screencasts are unnecessary, or that capture is blocked, explicitly remove any existing `## Screenshots` and `## Screencasts` sections instead of preserving stale proof from an earlier cycle.',
        );
      }
      expect(skillContent).toContain(
        '`body` set to the exact `/tmp/pr-body.md` contents',
      );
      expect(skillContent).toContain(
        'Immediately before the source-control mutation, derive the refreshed title and validate it together with the exact `/tmp/pr-body.md` against the inherited `pr-writing-contract`.',
      );
      expect(skillContent).not.toContain('order: asc');
      expect(skillContent).not.toMatch(/--body(?!-file)\b/);
      expect(skillContent).not.toContain(
        'Append a final footer blockquote to the PR body',
      );
      expect(skillContent).not.toContain(
        'Immediately before creating or refreshing the pull request, re-read the full current PR diff when a PR already exists, or the full base-to-head branch diff when it does not, and refresh the PR body if the change set narrowed or shifted during review, fixes, or follow-up edits.',
      );
      expect(skillContent).not.toContain(
        'Immediately before creating or refreshing the draft pull request, re-read the full current PR diff when a PR already exists, or the full base-to-head branch diff when it does not, and refresh the PR body if the change set narrowed or shifted during review, fixes, or follow-up edits.',
      );
      expect(skillContent).not.toContain(
        "Immediately after the successful push, re-read the final shipped diff, derive a refreshed PR title and body using the `pr-writing-guide` section below, and run `gh pr edit [PR_NUMBER] --repo [owner]/[repo] --title '...' --body '...'` so the existing PR metadata matches what now ships.",
      );
      expect(skillContent).not.toContain(
        'Keep the PR body grounded in the full current PR diff or base-to-head branch diff and do not include validation details.',
      );
      expect(skillContent).not.toContain(
        'Do not append a separate footer blockquote about mentioning `@roomote`',
      );
      expect(skillContent).not.toContain('side-by-side before/after tables');
      expect(skillContent).not.toContain(
        '`## Screenshots` -> `### Mobile` -> `### Desktop`',
      );
    }

    expect(createDraftPrSkill).toContain(
      'HEAD` to capture the full PR diff for the branch. Use this local git diff for every provider.',
    );
    expect(createDraftPrSkill).toContain(
      'Write `/tmp/pr-body.md` from the PR diff, recovered conversation, and still-applicable metadata under the inherited `pr-writing-contract`.',
    );
    expect(createDraftPrSkill).toContain(
      'When that uploaded artifact list does not exist and the latest proof handoff is an honest no-op result because this cycle did not run `capture-visual-proof`, preserve any existing `## Screenshots` and `## Screencasts` sections from the previous `/tmp/pr-body.md` when they already contain valid artifact URLs or screencast embeds.',
    );
    expect(createDraftPrSkill).toContain(
      'When that uploaded artifact list does not exist and the latest proof handoff reports that browser proof is not applicable, that screenshots and screencasts are unnecessary, or that capture is blocked, explicitly remove any existing `## Screenshots` and `## Screencasts` sections instead of preserving stale proof from an earlier cycle.',
    );
    for (const skillContent of [createPrSkill, createDraftPrSkill]) {
      expect(skillContent).toContain(
        'Apply the recipe, including its inherited PR-writing contract gate, before each `mcp__roomote__manage_source_control` mutation in this step.',
      );
      expect(skillContent).toContain(
        "Before writing `/tmp/pr-body.md`, check for a checked-in repository pull request or merge request template in the locations the repository's source-control provider supports.",
      );
      expect(skillContent).toContain(
        'On GitLab, inspect the `.md` files inside `.gitlab/merge_request_templates/`, preferring `Default.md` when present.',
      );
      expect(skillContent).toContain(
        'On Azure DevOps, inspect `.azuredevops/pull_request_template.md`',
      );
      expect(skillContent).toContain(
        'under the inherited `pr-writing-contract`.',
      );

      const mutationGateIndex = skillContent.indexOf(
        'Immediately before the source-control mutation, derive the refreshed title and validate it together with the exact `/tmp/pr-body.md` against the inherited `pr-writing-contract`.',
      );
      const mutationCallIndex = skillContent.indexOf(
        'Call `mcp__roomote__manage_source_control` with `action: "create_or_update_pull_request"`, `repositoryFullName: "<OWNER/REPO-or-provider-full-name>"`, `sourceBranch: "<current-branch>"`, `targetBranch: "<base-branch-for-this-repo>"`, `title: "<TITLE>"`,',
      );

      expect(mutationGateIndex).toBeGreaterThan(-1);
      expect(mutationCallIndex).toBeGreaterThan(mutationGateIndex);
      expect(skillContent).toContain(
        'and `body` set to the exact `/tmp/pr-body.md` contents.',
      );
      expect(skillContent).toContain(
        'Include `labels` only when a current conflict-resolver label is provided, and include `assignees` only when provider-compatible assignee usernames are available for this run.',
      );
      expect(skillContent).toContain(
        skillContent === createDraftPrSkill
          ? 'The tool creates a new draft pull request or refreshes the open one for the branch in a single call.'
          : 'The tool creates a new pull request or refreshes the open one for the branch in a single call.',
      );
      expect(skillContent).toContain(
        'Run `git diff $(git merge-base HEAD origin/<base-branch-for-this-repo> 2>/dev/null || echo "HEAD~1") HEAD` to capture the full',
      );
      expect(skillContent).toContain(
        'render `## Screenshots` from its reported screenshots only when present, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body',
      );
      expect(skillContent).toContain(
        'When no previous `/tmp/pr-body.md` exists, there is no prior body to preserve, so include visual proof sections only when current-cycle proof links are available and include `## Linked work items` only when the current workflow instructions provide one.',
      );
      expect(skillContent).toContain(
        'Do not use provider-specific PR CLIs such as `gh` for creation or refresh; the `mcp__roomote__manage_source_control` tool handles open pull request lookup and provider-specific mutation server-side.',
      );
      expect(skillContent).not.toContain('gh pr create');
      expect(skillContent).not.toContain('gh pr edit');
      expect(skillContent).not.toContain('gh pr list');
      expect(skillContent).not.toContain('gh pr view');
      expect(skillContent).not.toContain('gh pr ready');
      expect(skillContent).not.toContain(
        'When no open pull request exists yet',
      );
    }

    expect(fixPrSkill).toContain(
      'When no open pull request exists for the branch, report a blocker instead of refreshing: `create_or_update_pull_request` would open a new pull request, and `fix-pr` must never create one.',
    );
    expect(fixPrSkill).toContain(
      'Apply the recipe, including its inherited PR-writing contract gate, before the `mcp__roomote__manage_source_control` refresh mutation.',
    );
    expect(fixPrSkill).toContain(
      'If the current PR body conflicts with the selected template or fallback contract, rebuild it from the final shipped diff instead of preserving unrelated old sections.',
    );
    expect(fixPrSkill).toContain(
      'Immediately before the source-control mutation, derive the refreshed title and validate it together with the exact `/tmp/pr-body.md` against the inherited `pr-writing-contract`.',
    );
    expect(fixPrSkill).toContain(
      'Preserve or refresh `## Linked work items` when the current PR body or current workflow instructions identify linked work items.',
    );
    expect(fixPrSkill).toContain(
      'Visual proof sections are only `## Screenshots` and `## Screencasts` when current artifact links exist.',
    );
    expect(fixPrSkill).not.toContain('`## Visual Proof`');
    expect(fixPrSkill).not.toContain(
      "When no open pull request exists yet, run `gh pr create --repo <OWNER/REPO> --base '<base-branch-for-this-repo>' --title '<TITLE>' --body-file /tmp/pr-body.md`.",
    );
  });

  it('keeps implement workflow delegating PR metadata derivation to delivery skills', () => {
    const implementSkill = readSkill(
      '../skills/standard/implement-changes/SKILL.md',
    );

    expect(implementSkill).toContain(
      'Let the delegated delivery skill own pull request title/body derivation, screenshot and screencast embedding, related-PR links, and any PR metadata refresh using its `pr-metadata-update-recipe` plus the inherited `pr-writing-contract` instead of duplicating that procedure here.',
    );
    expect(implementSkill).toContain(
      'Let `fix-pr` own the post-push PR metadata refresh using its `pr-metadata-update-recipe` and the inherited `pr-writing-contract`.',
    );
    expect(implementSkill).toContain(
      "Follow the selected template's explicit title convention. Otherwise use exactly one of `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`",
    );
    expect(implementSkill).not.toContain(
      'Apply a `Net PR Changes Only` rule when writing the pull request title and body: base them on the full current PR diff for the branch plus only the conversation context that still matches what actually changed, not just the opening request, latest follow-up, or most recent commit.',
    );
  });
});
