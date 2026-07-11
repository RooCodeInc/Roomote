<!--
STOP: Please read before opening this PR.

Roomote does not generally accept unsolicited community pull requests right
now. The best way to help is a well-written issue: a clear bug report with
reproduction steps, or a focused feature request. Maintainers triage issues
actively, and a good report is genuinely more useful to us than an
unrequested diff.

Unless a maintainer explicitly invited this PR in an issue or discussion,
it will likely be closed without review. Opening an issue first is not a
formality we skip - it is the contribution process.

See CONTRIBUTING.md for details.
-->

<!--
Agents (including Roomote): Include the IMPORTANT warning, Related issue
(with Fixes # when applicable), and "## Why this PR exists" checkboxes for
human/community contributions.

OMIT those three sections entirely when either:
1. This PR is opened or refreshed by Roomote (body includes or will include
   a provenance blockquote with `Opened on behalf of`), or
2. The initiating user is listed in CODEOWNERS for this repository.

Do not check a "I am a maintainer" box as a substitute for omitting the
section — when Roomote provenance or CODEOWNER status already establishes
that path, the checklist is redundant noise.
-->

> [!IMPORTANT]
> Roomote does not generally accept unsolicited community pull requests. Unless a maintainer invited this PR in an issue or discussion, it will likely be closed without review. A [well-written issue](https://github.com/RooCodeInc/Roomote/issues/new/choose) is the best way to contribute.

## Related issue

<!--
For human/community PRs: link the issue where a maintainer agreed this change
should happen, and use "Fixes #123" so it closes automatically on merge.

Agents: when omitting the community gates above (Roomote provenance or
CODEOWNER), replace this section with a short note such as "Internal Roomote
work" / the task link, or drop the heading if there is nothing useful to say.
-->

Fixes #

## Why this PR exists

- [ ] A maintainer explicitly invited this PR in the linked issue or discussion
- [ ] I am a maintainer / this is internal Roomote work

## What changed

<!-- Describe the user-visible or reviewer-visible change, not a file-by-file list. -->

## How it was tested

<!-- Describe added tests or the manual validation performed. -->

## Checklist

- [ ] The PR title follows the repo convention: `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]` followed by a user-facing description
- [ ] This PR is small and scoped to one change
- [ ] `pnpm lint` and `pnpm check-types` pass locally
- [ ] I added tests or included a clear manual validation note above
- [ ] I removed secrets, tokens, private keys, and customer data from code, logs, and screenshots
- [ ] If this change should appear in the changelog, I ran `pnpm changeset`

<!--
First-time contributors: the CLA Assistant bot will comment on this PR with
signing instructions. You only need to sign once.
-->
