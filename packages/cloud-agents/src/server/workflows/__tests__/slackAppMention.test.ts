import {
  TaskPayloadKind,
  buildSlackThreadPermalink,
  type SlackAppMentionTask,
} from '@roomote/types';
import type { ResolvedTaskCommitAuthor } from '../../commit-author';

import {
  buildChatProviderMessageInstructions,
  slackAppMention,
} from '../slackAppMention';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const teamSpecificAppSlackPermalink = buildSlackThreadPermalink({
  slackTeamId: 'T123',
  slackChannelId: 'C456',
  threadTs: '1776819983.463289',
});
const exactSlackPermalink =
  'https://acme-team.slack.com/archives/C456/p1776819983463289?thread_ts=1776819983.463289&cid=C456';
const matchedSlackAttribution: ResolvedTaskCommitAuthor = {
  kind: 'user',
  displayName: 'Jane Doe',
  githubLogin: null,
  prAssigneeLogin: null,
  gitAuthor: {
    name: 'Jane Doe',
    email: '1+jane@users.noreply.github.com',
  },
};

describe('slackAppMention', () => {
  it('attaches Slack instructions for Slack app mention tasks', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote Can you explain the search_file tool?',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
    });

    expect(result.prompt).toContain(
      '&lt;slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false"&gt;',
    );
    expect(result.prompt).toContain('&lt;slack_message ts="123.456"&gt;');
    expect(result.prompt).toContain('Can you explain the search_file tool?');
    expect(result.prompt).not.toContain('@Roomote');
    expect(result.harnessInstructions).toContain('<workflow>');
    expect(result.harnessInstructions).toContain(
      '<slack_message_instructions>',
    );
    expect(result.harnessInstructions).toContain('<thread_context>');
    expect(result.harnessInstructions).toContain('<slack_thread_activity>');
    expect(result.harnessInstructions).toContain('<replying_to>');
    expect(result.harnessInstructions).toContain('<slack_response_delivery>');
    expect(result.harnessInstructions).toContain('send_chat_reply');
    expect(result.harnessInstructions).toContain('send_chat_reply');
    expect(result.harnessInstructions).toContain(
      'The `<thread_context>` block contains earlier messages from the Slack thread for conversational context. It may contain one or more `<slack_thread_message ts="...">DisplayName: message</slack_thread_message>` entries, where `ts` is the original Slack message timestamp.',
    );
    expect(result.harnessInstructions).toContain(
      "When present, the `<replying_to>` block highlights the most recent earlier Slack reply that the user is responding to, often the bot's latest Slack message. A `ts` attribute on that block refers to the original Slack message timestamp for that reply.",
    );
    expect(result.harnessInstructions).toContain(
      'When present, the `<slack_turn_policy ...>...</slack_turn_policy>` block is the source of truth for whether emoji reactions are allowed on the current Slack message and whether a lightweight acknowledgement should prefer an emoji reaction.',
    );
    expect(result.harnessInstructions).toContain(
      "The `<slack_message>` block contains the user's current message. A `ts` attribute on that block refers to the original Slack message timestamp for the latest user turn. This is what they're asking you to do.",
    );
    expect(result.harnessInstructions).toContain(
      "Messages wrapped in `<thread_activity>...</thread_activity>` are passive observations of other people's conversation in the Slack thread.",
    );
    expect(result.harnessInstructions).toContain(
      'Treat `thread_activity` as background context that may inform your current work. Do not pause your current task to respond to thread activity.',
    );
    expect(result.harnessInstructions).toContain('<slack_visibility_contract>');
    expect(result.harnessInstructions).toContain(
      'Task UI commentary, todo updates, internal reasoning, and ordinary tool results are not visible in Slack. Slack-visible actions for the current turn are `send_chat_reply`, `send_chat_reaction_emoji`, `post_to_channel`, and Slack-rendered `request_user_input` prompts.',
    );
    expect(result.harnessInstructions).toContain(
      'Intermediary updates belong in the `commentary` channel. They do not satisfy Slack turns and they are not Slack-visible replies.',
    );
    expect(result.harnessInstructions).toContain(
      'Before calling a Slack-visible reply tool, choose the current lifecycle purpose for the latest Slack user turn: `ack`, `progress`, `closeout`, or `clarification`. The message content should match that purpose.',
    );
    expect(result.harnessInstructions).toContain(
      '`ack`, `progress`, and `clarification` replies keep the Slack turn open. Obey the prompt-provided `<slack_turn_policy>` block for whether the current Slack message can receive emoji reactions.',
    );
    expect(result.harnessInstructions).toContain('<slack_turn_lifecycle>');
    expect(result.harnessInstructions).toContain(
      'A Slack user turn has a small lifecycle: acknowledge the turn when needed, report useful progress when there is useful new state, and close out when there is an answer, result, blocker, or a clear paused-waiting state. Slack uses this lifecycle for user-visible replies instead of treating Slack as an intermediary-update surface.',
    );
    expect(result.harnessInstructions).toContain(
      '`ack`: Send one early Slack-visible acknowledgement before substantial work that will not post to Slack when the answer is not immediate. When the `<slack_turn_policy>` block says `prefer_emoji_ack="true"`, the latest directed user turn itself came from Slack, and a lightweight acknowledgement is enough, acknowledge with `send_chat_reaction_emoji`.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not use `request_user_input` as a generic opening acknowledgement; only use it when the task is already blocked on concrete input from the user.',
    );
    expect(result.harnessInstructions).toContain(
      '`progress`: After an acknowledgement, send progress only when the update adds decision-useful state since the last Slack-visible reply: a material result, blocker, input need, changed approach, meaningful phase transition, proof artifact, or a timed update that prevents more than 10 minutes of Slack-visible silence during active work. When that timed update is warranted, keep it brief and outcome-level: say what is materially true now and what happens next in user terms instead of turning Slack into a running work log.',
    );
    expect(result.harnessInstructions).toContain(
      'When internal review, proof, or delegated helper steps create follow-up work, keep the update parent-owned and phase-based. Describe the current phase in human terms such as reviewing, tightening follow-ups, or final checking instead of naming the internal agent, review pass, or proof run unless that mechanism is itself the blocker or the user explicitly asked for it.',
    );
    expect(result.harnessInstructions).toContain(
      "When an active parent workflow delegates to a child skill and the parent still owns remaining proof, delivery, blocker handling, or final reporting, do not let the child satisfy the Slack closeout on its own. Treat that child completion as internal progress, keep any user-visible update parent-owned, and wait for the parent workflow's true terminal state before sending `send_chat_reply` with purpose `closeout`.",
    );
    expect(result.harnessInstructions).toContain(
      '`closeout`: Send one Slack-visible closeout when the turn has an answer, completed result, explicit blocker, or a paused-waiting state that you explain in prose. This is the only terminal `send_chat_reply` purpose.',
    );
    expect(result.harnessInstructions).toContain(
      'A `request_user_input` prompt or UI handoff never satisfies closeout on its own.',
    );
    expect(result.harnessInstructions).toContain(
      '`clarification`: Ask lightweight non-secret questions with `send_chat_reply` only when thread context and available tools do not already resolve the question well enough to continue.',
    );
    expect(result.harnessInstructions).toContain(
      'It does not satisfy ack or closeout on its own.',
    );
    expect(result.harnessInstructions).toContain(
      'For code-writing turns, the initial ack should say implementation is the next action when that is true and the agent already has enough inspected repository context to describe the work concretely. If the codebase has not been inspected yet, send a short text ack first and then start digging. Do not invent repo-specific details just to make the ack sound informed.',
    );
    expect(result.harnessInstructions).toContain(
      'Passive `thread_activity` can shape the next natural Slack reply when relevant, but it does not create a new lifecycle by itself. A new directed Slack user turn gets its own lifecycle.',
    );
    expect(result.harnessInstructions).toContain(
      'Keep Slack replies conversational and user-focused. Lead with the answer, takeaway, blocker, or current state. Use short plain-language messages unless the user asked for depth or the result needs structured Markdown.',
    );
    expect(result.harnessInstructions).toContain(
      'Sound like a capable teammate in a Slack thread: direct, lightly conversational, and allowed to be a little dry or self-aware when the thread supports it. Keep that subtle and sparse.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not reach for forced jokes, slang, hype, or "bro" phrasing. Avoid sounding like a support script, but also avoid sounding like you are performing a personality.',
    );
    expect(result.harnessInstructions).toContain(
      'Keep internal workflow names, tool logs, every todo transition, routine validation details, repeated heartbeat text, and internal reasoning out of Slack. Keep routine implementation-process chatter such as file reading, code editing, formatting, passing tests, and rerunning lint out of Slack unless it creates a blocker, delivery change, or concrete next step for the user.',
    );
    expect(result.harnessInstructions).toContain(
      "Match the user's technical depth. Default to conceptual plain-language explanations that summarize behavior, impact, or next steps; move into code-level detail, commands, file paths, or lower-level mechanics only when the user asked for that depth or that detail is genuinely needed to make the answer useful.",
    );
    expect(result.harnessInstructions).toContain(
      "Keep the parent as the only narrator on Slack. Treat subagents, review loops, proof capture, and similar helper mechanics as implementation detail, and keep ownership of the work in the parent's voice.",
    );
    expect(result.harnessInstructions).toContain(
      'Preserve narrative continuity across internal loops by translating them into a small set of stable user-facing phases instead of replaying each internal milestone. The first transition into a meaningful phase such as reviewing, tightening follow-ups, or final checking may warrant an update; repeated internal passes usually should be collapsed unless they materially change the outcome or extend the work enough that silence would feel confusing.',
    );
    expect(result.harnessInstructions).toContain(
      '<slack_modern_markdown>\n' +
        '    Slack replies from `send_chat_reply`, `post_to_channel`, and fast-agent final answers render in Slack `markdown` blocks, not legacy-limited mrkdwn.',
    );
    expect(result.harnessInstructions).toContain(
      '    Use modern Markdown as a readability tool when it improves scanability. Supported formatting includes:\n' +
        '    - headings: `#`, `##`, `###`\n' +
        '    - horizontal dividers: `---`\n' +
        '    - blockquotes: `> quoted text`\n' +
        '    - fenced code blocks with optional language labels\n' +
        '    - Markdown tables',
    );
    expect(result.harnessInstructions).toContain(
      '    Do not assume Slack formatting is limited to old mrkdwn. Do not avoid tables or code fences just because the target is Slack. Use them when they make the reply clearer.\n' +
        '    </slack_modern_markdown>',
    );
    expect(
      countOccurrences(
        result.harnessInstructions ?? '',
        '<slack_modern_markdown>',
      ),
    ).toBe(1);
    expect(
      countOccurrences(
        result.harnessInstructions ?? '',
        '</slack_modern_markdown>',
      ),
    ).toBe(1);
    expect(result.harnessInstructions).toContain(
      'Use normal markdown links for URLs.',
    );
    expect(result.harnessInstructions).toContain(
      'When a completed Slack answer or investigation reply mentions actionable repository code references such as files, methods, functions, classes, components, constants, queries, or routes, resolve the important ones to short-label GitHub blob permalinks at the exact revision you inspected. Use the checked-out commit for workspace-backed investigation, the PR head SHA when discussing a pull request, or the relevant inspected commit otherwise; add the narrowest resolvable line anchors, and if any part cannot be resolved confidently, mention the file or symbol in prose instead of inventing a link.',
    );
    expect(result.harnessInstructions).toContain(
      'When mentioning a preview, PR, task, or similar destination link in Slack, prefer inline markdown links on the relevant words such as `[live preview](...)` or `[draft PR](...)` instead of pasting bare URLs or adding a separate label-only sentence. Keep link labels short and descriptive.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not wrap URLs in backticks or use backticks as visual emphasis for ordinary prose.',
    );
    expect(result.harnessInstructions).not.toContain(
      'Use markdown tables when comparing a few rows or columns would be clearer than prose, but do not force tables for simple updates.',
    );
    expect(result.harnessInstructions).toContain(
      'Use `send_chat_reply` for lifecycle replies in the originating Slack thread when the reply needs words: early acknowledgements, useful progress, closeouts, and lightweight clarifications. Set its `purpose` to match the lifecycle purpose.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not run more tools first. The only non-reply exception is `tool_search` when the needed Slack reply/post tool is not visible.',
    );
    expect(result.harnessInstructions).toContain(
      'Use `send_chat_reaction_emoji` for lightweight acknowledgements, confirmations, or emoji-only answers only when the latest directed user turn came from Slack and the prompt-provided `<slack_turn_policy>` block allows reactions, especially when `prefer_emoji_ack="true"`.',
    );
    expect(result.harnessInstructions).toContain(
      'When using `send_chat_reaction_emoji`, choose the reaction that best matches the intent instead of treating `eyes` as the default. Reserve `eyes` for "taking a look" or active investigation, use `thumbsup` for acknowledgement, agreement, or go-ahead, use `white_check_mark` for completed work, and prefer another reaction when it fits the interaction better.',
    );
    expect(result.harnessInstructions).toContain(
      'At the beginning of a Slack turn, do not use `request_user_input` unless the next step is still genuinely blocked after using thread context and available tools to resolve the question.',
    );
    expect(result.harnessInstructions).toContain(
      'Keep Slack-visible replies in the originating thread by default, even when the context references a customer message, linked feedback thread, or another Slack channel.',
    );
    expect(result.harnessInstructions).toContain(
      'Use `post_to_channel` only when the current user explicitly asks you to send or relay an update to a different channel or thread. Do not use it to answer third parties just because another conversation appears in context.',
    );
    expect(result.harnessInstructions).toContain(
      'When a blocker, delivery update, input request, useful progress update, or closeout would otherwise leave the Slack thread hanging, post the concise Slack lifecycle reply before finalizing.',
    );
    expect(result.harnessInstructions).toContain(
      'Visual-proof uploads are not auto-posted to Slack for this task. When proof needs to be visible in the originating thread, share it with `send_chat_reply`: pass image artifact IDs via `imageArtifactIds`, or include artifact `viewUrl`/`rawUrl` links in the reply text for non-images.',
    );
    expect(result.harnessInstructions).toContain(
      'When other task-generated images were uploaded earlier in the same run and still need to be shown in the thread, pass those artifact IDs to `send_chat_reply` via `imageArtifactIds`.',
    );
    expect(result.harnessInstructions).not.toContain(
      'Built-in visual proof for the current proof milestone is already posted back to the originating Slack thread by the worker when trusted Slack context exists.',
    );
    expect(result.harnessInstructions).not.toContain(
      "When that built-in proof auto-post happens, do not send a second Slack reply that only narrates the visible proof, counts screenshots, names localhost capture URLs, mentions internal temp or artifact file paths, repeats the capture summary, or says there was no blocker. Treat the built-in proof post as the proof-ready update unless the proof is blocked or that detail materially changes the user's next step.",
    );
    expect(result.harnessInstructions).not.toContain(
      'Keep later Slack replies focused on the user outcome, delivery state, blocker, or next action rather than restating what is already visible in the proof attachments.',
    );
    expect(result.harnessInstructions).toContain(
      'When sharing screenshots or screencast links with `send_chat_reply`, and the environment instructions expose configured external preview URLs, include the most relevant preview link in the Slack text. Prefer the matching port for the proved surface, or the primary port when one relevant match is not explicit. Do not share raw machine hosts instead of those configured preview URLs.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not add a separate sentence telling the user to use the task UI; the Slack thread reply tool already appends the standard footer.',
    );
    expect(result.harnessInstructions).toContain(
      'When reactions are allowed and the latest directed user turn itself came from Slack, using `send_chat_reaction_emoji` on that current Slack message counts as answering that Slack turn. When the latest user turn did not come from Slack, `send_chat_reaction_emoji` does not count as satisfying the turn. When the user explicitly asks for a reaction on a different known Slack message, `add_reaction_to_slack_message` counts only when it targets that requested message.',
    );
    expect(result.harnessInstructions).toContain(
      "Every new Slack user turn that you answer still needs its own fresh Slack-visible satisfaction tool call. A prior turn's `send_chat_reply`, `send_chat_reaction_emoji`, or `add_reaction_to_slack_message` call on a different message does not satisfy a later turn. A reaction only counts for the turn it actually answers.",
    );
    expect(result.harnessInstructions).not.toContain(
      'Because this run originated from Slack, apply these Slack thread obligations before top-level workflow routing.',
    );
    expect(result.harnessInstructions).not.toContain(
      'For substantive Slack turns, the default visible milestone pair is `acknowledged` and `completed` unless one message can honestly satisfy both.',
    );
    expect(result.harnessInstructions).not.toContain(
      'For successful closeouts, focus Slack replies on the shipped change and any blocker or delivery outcome that materially affects the user; do not turn passed checks or pre-push gates into a validation ledger.',
    );
    expect(result.harnessInstructions).not.toContain(
      'If the run enters a long silent stretch after an acknowledgement, send one brief progress update before silence becomes confusing.',
    );
    expect(result.harnessInstructions).not.toContain('more than a few minutes');
    expect(result.harnessInstructions).not.toContain(
      'closeout or terminal reply',
    );
    expect(result.harnessInstructions).not.toContain(
      'use at most one short list',
    );
    expect(result.harnessInstructions).not.toContain(
      'Keep simple replies simple instead of adding structure for its own sake.',
    );
    expect(
      result.harnessInstructions?.indexOf('<slack_message_instructions>'),
    ).toBeLessThan(result.harnessInstructions?.indexOf('<workflow>') ?? 0);
  });

  it('guides normal Slack frequency answers toward short concrete replies', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote What would influence slack message frequency?',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
    });

    expect(result.prompt).toContain(
      '&lt;slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false"&gt;',
    );
    expect(result.prompt).toContain(
      '&lt;slack_message ts="123.456"&gt;\nWhat would influence slack message frequency?\n&lt;/slack_message&gt;',
    );
    expect(result.harnessInstructions).toContain(
      'Before calling a Slack-visible reply tool, choose the current lifecycle purpose for the latest Slack user turn: `ack`, `progress`, `closeout`, or `clarification`. The message content should match that purpose.',
    );
    expect(result.harnessInstructions).toContain(
      '`ack`: Send one early Slack-visible acknowledgement before substantial work that will not post to Slack when the answer is not immediate. When the `<slack_turn_policy>` block says `prefer_emoji_ack="true"`, the latest directed user turn itself came from Slack, and a lightweight acknowledgement is enough, acknowledge with `send_chat_reaction_emoji`.',
    );
    expect(result.harnessInstructions).toContain(
      '`progress`: After an acknowledgement, send progress only when the update adds decision-useful state since the last Slack-visible reply',
    );
    expect(result.harnessInstructions).toContain(
      'prevents more than 10 minutes of Slack-visible silence during active work',
    );
    expect(result.harnessInstructions).toContain(
      'For code-writing turns, the initial ack should say implementation is the next action when that is true and the agent already has enough inspected repository context to describe the work concretely',
    );
    expect(result.harnessInstructions).toContain(
      '`closeout`: Send one Slack-visible closeout when the turn has an answer, completed result, explicit blocker, or a paused-waiting state that you explain in prose.',
    );
    expect(result.harnessInstructions).toContain(
      'Keep Slack replies conversational and user-focused. Lead with the answer, takeaway, blocker, or current state.',
    );
    expect(result.harnessInstructions).toContain(
      'Sound like a capable teammate in a Slack thread: direct, lightly conversational, and allowed to be a little dry or self-aware when the thread supports it. Keep that subtle and sparse.',
    );
    expect(result.harnessInstructions).toContain(
      'Do not reach for forced jokes, slang, hype, or "bro" phrasing.',
    );
    expect(result.harnessInstructions).toContain(
      "Match the user's technical depth. Default to conceptual plain-language explanations that summarize behavior, impact, or next steps;",
    );
    expect(result.harnessInstructions).toContain(
      '<slack_modern_markdown>\n' +
        '    Slack replies from `send_chat_reply`, `post_to_channel`, and fast-agent final answers render in Slack `markdown` blocks, not legacy-limited mrkdwn.',
    );
    expect(result.harnessInstructions).toContain(
      '    Do not assume Slack formatting is limited to old mrkdwn. Do not avoid tables or code fences just because the target is Slack. Use them when they make the reply clearer.\n' +
        '    </slack_modern_markdown>',
    );
    expect(
      countOccurrences(
        result.harnessInstructions ?? '',
        '<slack_modern_markdown>',
      ),
    ).toBe(1);
    expect(result.harnessInstructions).not.toContain('Key Details');
    expect(result.harnessInstructions).not.toContain('detail fields');
    expect(result.harnessInstructions).not.toContain(
      'use at most one short list',
    );
    expect(result.harnessInstructions).not.toContain(
      'Keep simple replies simple instead of adding structure for its own sake.',
    );
    expect(result.harnessInstructions).not.toContain(
      'Slack-visible milestone pair',
    );
  });

  it('adds a Slack conversation permalink to delegated PR instructions when the Slack payload includes thread metadata', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        teamId: 'T123',
        channel: 'C456',
        user: 'U123',
        text: '@Roomote ship the fix',
        ts: '1776819983.463289',
        thread_ts: '1776819983.463289',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedSlackAttribution,
    });

    expect(result.harnessInstructions).toContain(
      `prepend \`> Opened on behalf of Jane Doe. Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${teamSpecificAppSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('prefers an exact Slack conversation permalink when the Slack payload provides one', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        teamId: 'T123',
        channel: 'C456',
        user: 'U123',
        text: '@Roomote ship the fix',
        ts: '1776819983.463289',
        thread_ts: '1776819983.463289',
        slackConversationUrl: exactSlackPermalink,
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedSlackAttribution,
    });

    expect(result.harnessInstructions).toContain(
      `prepend \`> Opened on behalf of Jane Doe. Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${exactSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('falls back to the source message ts when a Slack app mention is not yet in a thread', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        teamId: 'T123',
        channel: 'C456',
        user: 'U123',
        text: '@Roomote ship the fix',
        ts: '1776819983.463289',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedSlackAttribution,
    });

    expect(result.harnessInstructions).toContain(
      `prepend \`> Opened on behalf of Jane Doe. Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${teamSpecificAppSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('keeps the latest bot reply out of thread_context and highlights it separately', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote which messages do you see from this thread?',
        ts: '123.456',
        threadMessages: [
          {
            user: 'U111',
            username: 'Alice Example',
            text: 'Earlier thread detail',
            ts: '123.100',
            type: 'message',
          },
          {
            user: 'Uci',
            username: 'Deploy Bot',
            text: 'later routing message',
            ts: '123.300',
            bot_id: 'B999',
            type: 'message',
          },
          {
            user: 'U123',
            username: 'Bob Example',
            text: '@Roomote which messages do you see from this thread?',
            ts: '123.456',
            type: 'message',
          },
        ],
        latestOwnBotReplyText: 'bot reply',
        latestOwnBotReplyTs: '123.200',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
    });
    const botReplyOccurrences = (
      result.prompt.match(/Roomote: bot reply/g) ?? []
    ).length;

    expect(result.prompt).toContain('&lt;thread_context&gt;');
    expect(result.prompt).toContain(
      '&lt;slack_thread_message ts="123.100"&gt;Alice Example: Earlier thread detail&lt;/slack_thread_message&gt;',
    );
    expect(result.prompt).toContain(
      '&lt;slack_thread_message ts="123.300"&gt;Deploy Bot: later routing message&lt;/slack_thread_message&gt;',
    );
    expect(botReplyOccurrences).toBe(1);
    expect(result.prompt).toContain(
      '&lt;replying_to ts="123.200"&gt;\nRoomote: bot reply\n&lt;/replying_to&gt;',
    );
    expect(result.prompt).toContain(
      '&lt;slack_message ts="123.456"&gt;\nwhich messages do you see from this thread?\n&lt;/slack_message&gt;',
    );
  });

  it('includes bare-repo workspace readiness context in the prompt', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote investigate this repo',
        ts: '123.456',
        workspaceReadiness: 'bare_repo',
        readinessMessage:
          'Validation is limited until this repo is added to an environment.',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
    });

    expect(result.prompt).toContain(
      '&lt;workspace_readiness mode="bare_repo"&gt;',
    );
    expect(result.prompt).toContain(
      'This task is running in bare-repo mode without an environment-backed workspace.',
    );
    expect(result.prompt).toContain(
      'Validation is limited until this repo is added to an environment.',
    );
    expect(result.harnessInstructions).toContain(
      'Some Slack-launched tasks include a `<workspace_readiness>` block before the Slack message.',
    );
  });

  it('uses agentPromptText for the agent prompt while keeping payload text separate', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '**Idea 1: Fix cron retries**\nFix cron retries',
        agentPromptText:
          '**Idea 1: Fix cron retries**\nFix cron retries\n\nInvestigation context:\napps/api/src/jobs/retry.ts:92 drops the persisted retry delay.',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
    });

    expect(result.prompt).toContain(
      'Investigation context:\napps/api/src/jobs/retry.ts:92 drops the persisted retry delay.',
    );
  });

  it('documents built-in proof delivery for Slack visual proof', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote ship the fix',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
      visualProofAutoPostEnabled: true,
    });

    expect(result.harnessInstructions).toContain(
      'Built-in visual proof for the current proof milestone is already posted back to the originating Slack thread by the worker when trusted Slack context exists.',
    );
    expect(result.harnessInstructions).toContain(
      'When that built-in proof auto-post happens, do not send a second Slack reply that only narrates the visible proof',
    );
  });

  it('documents manual proof posting when Slack visual-proof auto-post is disabled', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote ship the fix',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/tasks/1',
      visualProofAutoPostEnabled: false,
    });

    expect(result.harnessInstructions).toContain(
      'Visual-proof uploads are not auto-posted to Slack for this task.',
    );
    expect(result.harnessInstructions).not.toContain(
      'Built-in visual proof for the current proof milestone is already posted back to the originating Slack thread by the worker when trusted Slack context exists.',
    );
  });
});

describe('buildChatProviderMessageInstructions', () => {
  it.each(['discord', 'teams', 'telegram'] as const)(
    'allows send_chat_reaction_emoji for %s turns (not Slack-only)',
    (provider) => {
      const instructions = buildChatProviderMessageInstructions(provider);

      expect(instructions).toContain('send_chat_reaction_emoji');
      expect(instructions).toContain('white_check_mark');
      expect(instructions).toContain('thumbsdown');
      expect(instructions).not.toContain(
        'Do not use Slack-only tools such as `send_chat_reaction_emoji`',
      );
    },
  );

  it.each(['discord', 'teams', 'telegram'] as const)(
    'teaches structured request_user_input rendering for %s',
    (provider) => {
      const label =
        provider === 'discord'
          ? 'Discord'
          : provider === 'telegram'
            ? 'Telegram'
            : 'Teams';
      const instructions = buildChatProviderMessageInstructions(provider);

      expect(instructions).toContain(
        'do not use `request_user_input` unless the next step is still genuinely blocked after using thread context and available tools to resolve the question',
      );
      expect(instructions).toContain(
        `A ${label}-rendered \`request_user_input\` prompt is supplemental and never satisfies ack or closeout on its own`,
      );
      expect(instructions).toContain(
        'use `request_user_input` in progressive blocks of up to 4 questions',
      );
    },
  );

  it.each(['discord', 'teams', 'telegram'] as const)(
    'matches Slack parent-owned single-closeout lifecycle guidance for %s',
    (provider) => {
      const label =
        provider === 'discord'
          ? 'Discord'
          : provider === 'telegram'
            ? 'Telegram'
            : 'Teams';
      const instructions = buildChatProviderMessageInstructions(provider);

      expect(instructions).toContain(
        `When an active parent workflow delegates to a child skill and the parent still owns remaining proof, delivery, blocker handling, or final reporting, do not let the child satisfy the ${label} closeout on its own.`,
      );
      expect(instructions).toContain(
        `Keep the parent as the only narrator on ${label}.`,
      );
      expect(instructions).toContain(
        'Do not send another closeout that restates the same delivery outcome',
      );
      expect(instructions).toContain(
        'do not re-post a second near-identical lifecycle reply just because stop or silence machinery asks for another chat-visible update',
      );
      expect(instructions).toContain(
        'One ' +
          label +
          ' message can satisfy multiple lifecycle purposes only when its content genuinely does so.',
      );
    },
  );

  it.each(['discord', 'teams', 'telegram'] as const)(
    'documents manual visual-proof posting when auto-post is disabled for %s',
    (provider) => {
      const label =
        provider === 'discord'
          ? 'Discord'
          : provider === 'telegram'
            ? 'Telegram'
            : 'Teams';
      const instructions = buildChatProviderMessageInstructions(provider, {
        visualProofAutoPostEnabled: false,
      });

      expect(instructions).toContain(
        `Visual-proof uploads are not auto-posted to ${label} for this task.`,
      );
      expect(instructions).toContain('imageArtifactIds');
      expect(instructions).toContain(
        'pass those artifact IDs to `send_chat_reply` via `imageArtifactIds`',
      );
      expect(instructions).not.toContain(
        `Built-in visual proof for the current proof milestone is already posted back to the originating ${label} thread by the worker when trusted ${label} context exists.`,
      );
    },
  );

  it.each(['discord', 'teams', 'telegram'] as const)(
    'documents built-in visual-proof auto-post when enabled for %s',
    (provider) => {
      const label =
        provider === 'discord'
          ? 'Discord'
          : provider === 'telegram'
            ? 'Telegram'
            : 'Teams';
      const instructions = buildChatProviderMessageInstructions(provider, {
        visualProofAutoPostEnabled: true,
      });

      expect(instructions).toContain(
        `Built-in visual proof for the current proof milestone is already posted back to the originating ${label} thread by the worker when trusted ${label} context exists.`,
      );
      expect(instructions).toContain(
        `When that built-in proof auto-post happens, do not send a second ${label} reply that only narrates the visible proof`,
      );
      expect(instructions).not.toContain(
        `Visual-proof uploads are not auto-posted to ${label} for this task.`,
      );
    },
  );
});
