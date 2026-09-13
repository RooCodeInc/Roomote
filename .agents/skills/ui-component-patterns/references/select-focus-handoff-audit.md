# Select focus handoff audit

Status: approved clear-next-step recommendations are adopted. Conditional and
negative candidates remain unchanged where movement would be surprising,
optional, or premature.

The shared Radix Select accepts `handoffTargetOnSelect`, an explicit ref to an
`Input`, `Textarea`, or another shared Select's `handoffRef`. It never infers a
destination from DOM order.

## Adoption summary

Adopted: onboarding and settings provider credentials, custom cron entry,
manual manager-channel entry, empty/ready automation destinations, new model
slug entry, and Discord server-to-channel selection. The Discord chain waits
through channel loading and opens only if supported choices exist and focus is
still on the server trigger.

Skipped: optional environment branch/working-directory fields, model-to-effort
pairs, analytics filter rows, service rows, action buttons, and custom
Popover/Command selectors. These either already have a valid value, are not a
required next step, or need a separate custom-control focus contract.

## Recommendations

1. **Onboarding: model provider to primary credential**
   - Source: `apps/web/src/app/(onboarding)/setup/StepInferenceProvider.tsx:364-413`
   - Relationship: committing a non-OAuth provider reveals its API-key or
     endpoint input in the same row. OAuth providers reveal a connect button
     instead.
   - Decision: **Adopted for non-OAuth providers only.** Credential entry is
     the immediate required next action. Do not hand off when the field is
     disabled because a runtime credential already exists.
   - Compatibility: direct shared Radix `Select`; the conditional input needs a
     stable ref passed to `handoffTargetOnSelect`.

2. **Settings, Add Provider dialog: provider to connection name or credential**
   - Source: `apps/web/src/components/settings/InferenceProviderSection.tsx:429-546`
   - Relationship: provider choice resets and changes the conditional form. An
     OpenAI-compatible endpoint first reveals Connection name; other non-OAuth
     providers first reveal their primary credential. OAuth choices lead to a
     connect action rather than text entry.
   - Decision: **Adopted conditionally.** Target the first required text field
     for the committed provider, and omit the target for OAuth providers. This
     needs one explicit dynamic ref rather than DOM-order inference.
   - Compatibility: direct shared Radix `Select`; controlled Select state and
     conditional destination mounting are supported by the shared API.

3. **Custom Automations: Custom schedule to cron expression**
   - Source: `apps/web/src/components/settings/automations/CustomAutomationsSection.tsx:904-968`
   - Relationship: choosing the `cron` schedule mode reveals the Custom schedule
     input beside the Select; every other schedule mode removes it.
   - Decision: **Adopted only for `cron`.** The choice explicitly creates a
     required text-entry step and is strong on both desktop and mobile.
   - Compatibility: direct shared Radix `Select`; add a ref to
     `#custom-automation-cron` and supply it only for the custom mode.

4. **Automations: manager channel to private/manual channel entry**
   - Source: `apps/web/src/components/settings/automations/ManagerChannelEditor.tsx:181-306`
   - Relationship: choosing Private or manual channel enables and reveals the
     channel-name/Slack-ID input. Catalog choices and Clear selection do not.
   - Decision: **Adopted only for the manual option.** The label states an
     intent to type or paste, so the focus move is predictable; it will also
     intentionally open a mobile keyboard.
   - Compatibility: direct shared Radix `Select`; the conditional input needs a
     ref. Existing `isEnteringCustomChannel` state already identifies the mode.

5. **Custom Automation destination: provider/type to raw destination ID**
   - Source: `apps/web/src/components/settings/automations/AutomationDestinationPicker.tsx:99-282`
   - Relationship: provider and destination-type choices can replace the next
     control with a raw Slack/Discord/Teams/Telegram ID input, a catalog picker,
     an Email Select, or explanatory DM text.
   - Decision: **Adopted for empty, ready destinations.** Provider/type commits
     hand off to an empty raw ID field or empty shared Discord/Email Select.
     Existing defaults, DM branches, and unavailable/custom catalog controls
     retain normal focus.
   - Compatibility: the provider and mode controls use the shared Radix
     `Select`; `SlackChannelSelect` is a distinct Popover/Command implementation
     and should not inherit this API.

6. **Models: provider to new model slug**
   - Source: `apps/web/src/components/settings/ModelSettingsSection.tsx:1858-1955`
   - Relationship: changing provider updates the prefix and suggestions for the
     always-visible New model slug input immediately beside the Select.
   - Decision: **Adopted.** The instruction says to
     choose a provider and enter a slug, and the destination already has a ref.
     The input's existing suggestion Popover retains ownership of its own open
     behavior.
   - Compatibility: direct shared Radix `Select` to an Input wrapped by a
     separate Popover. The existing `inputRef` is compatible.

7. **Environment repository: repository to optional branch**
   - Source: `apps/web/src/components/settings/environments/RepositoryEditor.tsx:64-126`
   - Relationship: repository and Branch are adjacent, always-present controls;
     Branch is optional and defaults to the repository's default branch.
   - Decision: **Skipped.** Most users can finish repository selection without
     typing a branch, so opening a mobile keyboard or moving screen-reader focus
     would overstate the optional field's importance.
   - Compatibility: technically direct shared Radix `Select`, but product intent
     does not justify opting in.

8. **Docker project: source/repository to working directory or compose fields**
   - Source: `apps/web/src/components/settings/environments/DockerProjectListEditor.tsx:78-199`
   - Relationship: Source and Repository Selects sit in a grid with an
     always-present optional Working directory input. Choosing Docker Compose
     additionally reveals Compose files and Services inputs farther down.
   - Decision: **Skipped.** The nearest input is optional and independent, and
     the conditional compose fields are not an unambiguous single destination.
     Focus transfer would be especially surprising on mobile.
   - Compatibility: direct shared Radix `Select` controls, but no suitable
     explicit target exists without a stronger product decision.

9. **Discord settings: server to default channel**
   - Source: `apps/web/src/components/settings/DiscordDefaultChannelPicker.tsx:114-173`
   - Relationship: the server choice determines and asynchronously loads the
     enabled channel choices.
   - Decision: **Adopted when a channel is still required.** The channel Select
     opens immediately when ready, or after loading only if supported channels
     exist and focus is still on the server trigger. An existing channel choice
     is never reopened.
   - Compatibility: both controls use the shared Radix `Select`; the downstream
     control exposes `handoffRef`.

10. **Model to reasoning-effort Selects**
    - Sources: `apps/web/src/components/tasks/SessionModelSwitcher.tsx:72-95`,
      `apps/web/src/components/settings/automations/CustomAutomationsSection.tsx:977-1048`,
      and `apps/web/src/components/settings/ModelSettingsSection.tsx:274-310`.
    - Relationship: model capability changes whether a neighboring reasoning
      selector is available.
    - Decision: **Skipped.** Reasoning effort is optional and often already
      valid. Automatically opening it would interrupt users who only intended
      to change the model.
    - Compatibility: technically compatible after wrapper ref forwarding, but
      not a clear required next step.

11. **Analytics metric/group/time/granularity selectors**
    - Source: `apps/web/src/app/(authenticated)/analytics/AnalyticsControlRow.tsx:45-77`
      and its selector components.
    - Relationship: a responsive toolbar of related but independently useful
      filters.
    - Decision: **Skipped.** This is not a guided chain; stable focus is less
      surprising for keyboard and screen-reader users.

12. **Repeated environment service/version selectors**
    - Source: `apps/web/src/components/settings/environments/VisualEnvironmentEditor.tsx:230-276`.
    - Relationship: repeated row-local choices that may appear or disappear.
    - Decision: **Skipped.** There is no stable next destination, especially
      after responsive wrapping.

13. **Channel auto-start provider tabs to channel selector**
    - Source: `apps/web/src/components/settings/automations/ChannelAutoStartEditor.tsx:218-284`.
    - Relationship: Tabs conditionally mount a custom `SlackChannelSelect` or
      fallback input.
    - Decision: **Skipped for this API.** The source is not a Select and the
      custom Popover/Command target needs a separate explicit focus contract.

## Plausible negative sites reviewed

- `apps/web/src/components/github/CreateGitHubRepoDialog.tsx:232-304`: the Owner
  Select is in the New repository branch; the repository URL Input belongs to a
  mutually exclusive Fork existing branch. **No handoff.**
- `apps/web/src/components/settings/AdditionalEnvFieldInput.tsx:14-71`: this
  shared renderer chooses either a Select or an Input for one field, never a
  Select followed by its own destination. **No handoff at the wrapper level.**
- `apps/web/src/components/settings/DeploymentTimeZoneSetting.tsx:115-179`:
  `CommandInput` searches inside the timezone picker; the post-selection action
  is Save timezone. **No destination text field.**
- `apps/web/src/components/tasks/ModelSelect.tsx` and
  `ReasoningEffortSelect.tsx`: shared task configuration controls have no
  implied text destination. The searchable model variant's `CommandInput` is
  internal search, not a handoff target. **No shared-wrapper adoption.**
- `apps/web/src/components/settings/environments/EditEnvironmentPage.tsx:529-551`:
  the native version selector changes YAML editor content rather than revealing
  a distinct text field. **No handoff.**
- Analytics selectors under
  `apps/web/src/app/(authenticated)/analytics/` update filters and charts.
  **No text-entry destination.**
- `apps/web/src/components/settings/DeploymentTimeZoneSetting.tsx`,
  `SlackChannelSelect.tsx`, task file/command search, and the command palette use
  Popover/Command comboboxes whose text inputs search within the selector.
  **Do not treat internal search as a post-selection destination.**
- Remaining provider, region, entity, policy, user, compute, source-control, and
  environment Selects under `apps/web/src/components/settings/` were reviewed.
  Nearby inputs are independent, precede the selector, or are not the clear next
  action. **No current recommendation.**

## Coverage

The audit searched all tracked web TSX sources for shared `SelectTrigger`
usage, native `<select>`, `role="combobox"`, Command-based selectors, Popover
selectors, `Input`, and `Textarea`, then traced shared wrappers to callers and
inspected conditional branches. All 29 non-test/non-story files containing the
shared Select trigger were reviewed, along with custom selector implementations
and their user-facing callers. Stories and tests were checked as implementation
evidence but are not counted as product sites; database query `.select()` calls
and selectors with no nearby or conditional text entry were excluded.

This audit began at revision `7f749755`. Runtime feature flags,
deployment-specific option catalogs, and forms generated entirely by external
content could alter which conditional branch a user sees. Browser validation
remains important for assistive-technology announcements and software-keyboard
behavior that jsdom cannot reproduce.
