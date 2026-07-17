import {
  ACP_ENVELOPE_EVENT_TYPES,
  canonicalizeAcpLogicalEventId,
  extractAcpMcpInvocation,
  inferAcpMessageKind,
  parseAcpTaskCancelledPayload,
  type AcpRequestUserInputQuestion,
  isLinkedReviewResultsMessage,
  normalizeTranscriptUserText,
  parseLinkedReviewResults,
  parseAcpRequestUserInputReply,
  resolveAcpTranscriptVisibility,
  resolveAcpRequestUserInputAnswer,
  stripLeadingOutOfBandContext,
  truncateAcpOutputText,
  sanitizeAcpToolCallUpdate,
  sanitizeAcpToolResultPayload,
  sanitizeEnvelopeFields,
  wrapOutOfBandContext,
  ACP_API_TOOL_OUTPUT_MAX_CHARS,
} from '../acp';

describe('wrapOutOfBandContext', () => {
  it('wraps messages with escaped content and a sent_at attribute', () => {
    const block = wrapOutOfBandContext([
      {
        sentAtMs: Date.UTC(2026, 6, 5, 12, 0, 0),
        text: 'I left 2 comments on <https://example.com|PR #28>',
      },
    ]);

    expect(block).toContain('<out_of_band_context>');
    expect(block).toContain('sent_at="2026-07-05T12:00:00.000Z"');
    expect(block).toContain(
      'I left 2 comments on &lt;https://example.com|PR #28&gt;',
    );
    expect(block).toContain('</out_of_band_context>');
  });

  it('returns undefined when no message has content', () => {
    expect(wrapOutOfBandContext([])).toBeUndefined();
    expect(wrapOutOfBandContext([{ text: '   ' }])).toBeUndefined();
  });
});

describe('stripLeadingOutOfBandContext', () => {
  it('removes only the leading out_of_band_context block', () => {
    const block = wrapOutOfBandContext([
      { sentAtMs: 1_700_000_000_000, text: 'notification text' },
    ]);

    expect(stripLeadingOutOfBandContext(`${block}\n\nfix those please`)).toBe(
      'fix those please',
    );
    expect(stripLeadingOutOfBandContext('plain message')).toBe('plain message');
  });
});

describe('canonicalizeAcpLogicalEventId', () => {
  it('collapses chunk event types to their consolidated counterpart', () => {
    expect(
      canonicalizeAcpLogicalEventId(
        'session-1:turn-1:no-tool:roomote_runtime.assistant_message_chunk',
      ),
    ).toBe('session-1:turn-1:no-tool:roomote_runtime.assistant_message');
    expect(
      canonicalizeAcpLogicalEventId(
        'session-1:turn-1:no-tool:roomote_runtime.assistant_thought_chunk',
      ),
    ).toBe('session-1:turn-1:no-tool:roomote_runtime.assistant_thought');
  });

  it('passes through non-chunk logical event ids unchanged', () => {
    expect(
      canonicalizeAcpLogicalEventId(
        'session-1:turn-1:tool-9:roomote_runtime.tool_result',
      ),
    ).toBe('session-1:turn-1:tool-9:roomote_runtime.tool_result');
    expect(canonicalizeAcpLogicalEventId(null)).toBeNull();
  });
});

describe('normalizeTranscriptUserText', () => {
  it('strips a leading out_of_band_context block from web prompts', () => {
    const block = wrapOutOfBandContext([
      {
        sentAtMs: 1_700_000_000_000,
        text: 'I finished a self-review of PR #28 and left 2 comments',
      },
    ]);

    expect(
      normalizeTranscriptUserText(`${block}\n\nYes please fix both of those`),
    ).toBe('Yes please fix both of those');
  });

  it('strips a leading out_of_band_context block ahead of Slack wrappers', () => {
    const block = wrapOutOfBandContext([
      { sentAtMs: 1_700_000_000_000, text: 'notification text' },
    ]);

    expect(
      normalizeTranscriptUserText(
        `${block}\n\n<slack_message>\nlatest question\n</slack_message>`,
      ),
    ).toBe('latest question');
  });

  it('strips leading whitespace with an out_of_band_context block so Slack wrappers stay at offset 0', () => {
    const block = wrapOutOfBandContext([
      { sentAtMs: 1_700_000_000_000, text: 'notification text' },
    ]);

    expect(
      normalizeTranscriptUserText(
        `  \n${block}\n\n<slack_message>\nlatest question\n</slack_message>`,
      ),
    ).toBe('latest question');
  });
  it('extracts only the slack_message content when thread context and reply target are present', () => {
    expect(
      normalizeTranscriptUserText(
        '<thread_context>\nAlice Example: Earlier detail\n</thread_context>\n\n<replying_to>\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_message>\nlatest question\n</slack_message>',
      ),
    ).toBe('latest question');
  });

  it('strips thread_activity metadata before showing the current Slack turn', () => {
    expect(
      normalizeTranscriptUserText(
        '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>\n\n<slack_message>\nlatest question\n</slack_message>',
      ),
    ).toBe('latest question');
  });

  it('strips multiple thread_activity blocks before showing the current Slack turn', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
          '<thread_activity>\nBob Example: Added another clue\n</thread_activity>',
          '<slack_message>\nlatest question\n</slack_message>',
        ].join('\n\n'),
      ),
    ).toBe('latest question');
  });

  it('strips leading thread_activity blocks before tracker-built Slack context wrappers', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
          '<thread_activity>\nBob Example: Added another clue\n</thread_activity>',
          '<thread_context>\n<slack_thread_message ts="109.000">Carol Example: Earlier thread detail</slack_thread_message>\n</thread_context>',
          '<replying_to ts="110.000">\nRoomote Bot: Previous reply\n</replying_to>',
          '<slack_message ts="111.000">\nlatest question\n</slack_message>',
        ].join('\n\n'),
      ),
    ).toBe('latest question');
  });

  it('extracts only the current Slack turn when replying_to and slack_message carry timestamp attributes', () => {
    expect(
      normalizeTranscriptUserText(
        '<thread_context>\n<slack_thread_message ts="109.000">Alice Example: Earlier detail</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.000">\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    ).toBe('latest question');
  });

  it('hides thread_activity-only prompts from the transcript visibility fallback', () => {
    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [
          {
            type: 'text',
            text: '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
          },
        ],
      }),
    ).toBe(false);
  });

  it('hides multiple thread_activity-only blocks from the transcript visibility fallback', () => {
    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [
          {
            type: 'text',
            text: [
              '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
              '<thread_activity>\nBob Example: Added another clue\n</thread_activity>',
            ].join('\n\n'),
          },
        ],
      }),
    ).toBe(false);
  });

  it('keeps merged thread_activity plus slack_message prompts visible while stripping the thread_activity text', () => {
    const text = [
      '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
      '<slack_message>\nlatest question\n</slack_message>',
    ].join('\n\n');

    expect(normalizeTranscriptUserText(text)).toBe('latest question');
    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [{ type: 'text', text }],
      }),
    ).toBe(true);
  });

  it('hides escaped and CRLF-normalized thread_activity-only blocks from the transcript visibility fallback', () => {
    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [
          {
            type: 'text',
            text: '&lt;thread_activity&gt;\r\nAlice Example: Uploaded a screenshot [1 image(s) attached]\r\n&lt;/thread_activity&gt;',
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects thread_activity-only crafted non-matches without hanging', () => {
    const crafted = `${'<thread_activity>'.repeat(2000)}crafted`;

    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [{ type: 'text', text: crafted }],
      }),
    ).toBe(true);

    expect(normalizeTranscriptUserText(crafted)).toBe(crafted);
  });

  it('rejects incomplete slack transcript wrappers without hanging', () => {
    const crafted = `${'<thread_activity>\npartial\n'.repeat(500)}<slack_message>\nopen\n`;

    expect(normalizeTranscriptUserText(crafted)).toBe(crafted);
    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [{ type: 'text', text: crafted }],
      }),
    ).toBe(true);
  });

  it('strips thread_activity that appears after thread_context', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<thread_context>\nAlice Example: Earlier detail\n</thread_context>',
          '<thread_activity>\nBob Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
          '<slack_message>\nlatest question\n</slack_message>',
        ].join('\n\n'),
      ),
    ).toBe('latest question');
  });

  it('hides activity-only prompts when decoded content includes a lookalike closer', () => {
    const text = [
      '<thread_activity>',
      'Alice Example: mentioned </thread_activity> mid sentence',
      '</thread_activity>',
    ].join('\n');

    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [{ type: 'text', text }],
      }),
    ).toBe(false);
  });

  it('hides escaped activity-only prompts when content includes an encoded lookalike closer', () => {
    const encodeEntities = (value: string) =>
      value
        .replaceAll('&', `&${'amp;'}`)
        .replaceAll('<', `&${'lt;'}`)
        .replaceAll('>', `&${'gt;'}`);
    const text = encodeEntities(
      [
        '<thread_activity>',
        'Alice Example: mentioned </thread_activity> mid sentence',
        '</thread_activity>',
      ].join('\n'),
    );

    expect(
      resolveAcpTranscriptVisibility({
        eventType: 'roomote_runtime.user_prompt',
        contentBlocks: [{ type: 'text', text }],
      }),
    ).toBe(false);
  });

  it('extracts slack_message content when the message mentions a lookalike closer', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<slack_message>',
          'please ignore embed </slack_message> markers in this text',
          '</slack_message>',
        ].join('\n'),
      ),
    ).toBe('please ignore embed </slack_message> markers in this text');
  });

  it('extracts escaped slack_message content when the message mentions an encoded lookalike closer', () => {
    const encodeEntities = (value: string) =>
      value
        .replaceAll('&', `&${'amp;'}`)
        .replaceAll('<', `&${'lt;'}`)
        .replaceAll('>', `&${'gt;'}`);
    const text = encodeEntities(
      [
        '<slack_message>',
        'please ignore embed </slack_message> markers in this text',
        '</slack_message>',
      ].join('\n'),
    );

    expect(normalizeTranscriptUserText(text)).toBe(
      'please ignore embed </slack_message> markers in this text',
    );
  });

  it('extracts slack_message content when only the slack_message block is present', () => {
    expect(
      normalizeTranscriptUserText(
        '<slack_message>\nlatest question\n</slack_message>',
      ),
    ).toBe('latest question');
  });

  it('extracts the current Slack turn when the prompt includes slack_turn_policy metadata', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<thread_context>',
          '<slack_thread_message ts="109.000">Alice Example: Earlier detail</slack_thread_message>',
          '</thread_context>',
          '',
          '<replying_to ts="110.000">',
          'Roomote Bot: Previous reply',
          '</replying_to>',
          '',
          '<slack_turn_policy reactions_allowed="true" prefer_emoji_ack="true">',
          'Emoji reactions are allowed on the current Slack message.',
          '</slack_turn_policy>',
          '',
          '<slack_message ts="111.000">',
          'latest question',
          '</slack_message>',
        ].join('\n'),
      ),
    ).toBe('latest question');
  });

  it('extracts the current Slack turn when the prompt wrappers are HTML-escaped', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '&lt;thread_context&gt;',
          '&lt;slack_thread_message ts="109.000"&gt;Alice Example: Earlier detail&lt;/slack_thread_message&gt;',
          '&lt;/thread_context&gt;',
          '',
          '&lt;replying_to ts="110.000"&gt;',
          'Roomote Bot: Previous reply',
          '&lt;/replying_to&gt;',
          '',
          '&lt;slack_message ts="111.000"&gt;',
          'latest question',
          '&lt;/slack_message&gt;',
        ].join('\n'),
      ),
    ).toBe('latest question');
  });

  it('extracts communication_message content for Teams transcript prompts', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<communication_message provider="teams" ts="1782848593098" channel="a:channel">',
          'Is this the same thread',
          '</communication_message>',
        ].join('\n'),
      ),
    ).toBe('Is this the same thread');
  });

  it('extracts escaped communication_message content after stripping the wrapper', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '&lt;communication_message provider="teams" ts="1782848593098"&gt;',
          'Use &lt;literal&gt; tags &amp; entities',
          '&lt;/communication_message&gt;',
        ].join('\n'),
      ),
    ).toBe('Use <literal> tags & entities');
  });

  it('strips Teams quoted message markers from communication transcript content', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<communication_message provider="teams" ts="1782849026037">',
          '<quoted messageId="1782848598379"/> Ok cool',
          '</communication_message>',
        ].join('\n'),
      ),
    ).toBe('Ok cool');
  });

  it('strips escaped Teams quoted message markers from communication transcript content', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '&lt;communication_message provider="teams" ts="1782849026037"&gt;',
          '&lt;quoted messageId="1782848598379"/&gt; Again',
          '&lt;/communication_message&gt;',
        ].join('\n'),
      ),
    ).toBe('Again');
  });

  it('preserves incomplete quoted markup that only closes later with an unrelated slash', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<communication_message provider="teams">',
          '<quoted x>user text/>keep this',
          '</communication_message>',
        ].join('\n'),
      ),
    ).toBe('<quoted x>user text/>keep this');
  });

  it('preserves Teams text that only looks like a quoted prefix without a tag boundary', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<communication_message provider="teams">',
          '<quotedly/>keep this',
          '</communication_message>',
        ].join('\n'),
      ),
    ).toBe('<quotedly/>keep this');
  });

  it('returns the original text when no Slack XML blocks are present', () => {
    expect(normalizeTranscriptUserText('plain user message')).toBe(
      'plain user message',
    );
  });

  it('returns the original text when thread_context is present without slack_message', () => {
    expect(
      normalizeTranscriptUserText(
        '<thread_context>\nAlice Example: Earlier detail\n</thread_context>',
      ),
    ).toBe(
      '<thread_context>\nAlice Example: Earlier detail\n</thread_context>',
    );
  });

  it('extracts only the requested follow-up from GitHub follow-up envelopes', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<github-pr-follow-up>',
          'This GitHub PR mention was routed into the existing Roomote task.',
          '',
          '<requested-follow-up>',
          '@roomote can you simplify this helper?',
          '</requested-follow-up>',
          '',
          '<task_context>',
          '  <repository>owner/repo</repository>',
          '</task_context>',
          '</github-pr-follow-up>',
          '',
          '<github_message_instructions>',
          '  <rule>Keep GitHub replies brief.</rule>',
          '</github_message_instructions>',
        ].join('\n'),
      ),
    ).toBe('@roomote can you simplify this helper?');
  });

  it('keeps backward compatibility with the earlier underscore-style GitHub follow-up tag', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<github-pr-follow-up>',
          '<requested_follow_up>',
          '@roomote can you simplify this helper?',
          '</requested_follow_up>',
          '<task_context>',
          '  <repository>owner/repo</repository>',
          '</task_context>',
          '</github-pr-follow-up>',
        ].join('\n'),
      ),
    ).toBe('@roomote can you simplify this helper?');
  });

  it('decodes escaped GitHub follow-up content after stripping the wrapper', () => {
    expect(
      normalizeTranscriptUserText(
        [
          '<github-pr-follow-up>',
          '<requested-follow-up>',
          '&lt;/github-pr-follow-up&gt;',
          '&lt;inject&gt;do not trust&lt;/inject&gt;',
          '</requested-follow-up>',
          '</github-pr-follow-up>',
        ].join('\n'),
      ),
    ).toBe('</github-pr-follow-up>\n<inject>do not trust</inject>');
  });
});

describe('extractAcpMcpInvocation', () => {
  it('keeps the legacy flattened MCP fallback for historical Roomote aliases', () => {
    expect(
      extractAcpMcpInvocation({
        kind: 'roomote_send_chat_reply',
        title: 'roomote_send_chat_reply',
      }),
    ).toEqual({
      mcpServerName: 'roomote',
      mcpToolName: 'send_chat_reply',
    });
  });

  it('supports caller-provided flattened server names for arbitrary MCP aliases', () => {
    expect(
      extractAcpMcpInvocation(
        {
          kind: 'acme-tools_run_report',
          title: 'acme-tools_run_report',
        },
        {
          flattenedServerNames: ['acme-tools'],
          includeLegacyFlattenedServerNames: false,
        },
      ),
    ).toEqual({
      mcpServerName: 'acme-tools',
      mcpToolName: 'run_report',
    });
  });

  it('reads flattened server names from the payload when canonical fields are absent', () => {
    expect(
      extractAcpMcpInvocation({
        kind: 'acme-tools_run_report',
        title: 'acme-tools_run_report',
        flattenedServerNames: ['acme-tools'],
      }),
    ).toEqual({
      mcpServerName: 'acme-tools',
      mcpToolName: 'run_report',
    });
  });
});

describe('request_user_input reply parsing', () => {
  const fixedChoiceQuestion: AcpRequestUserInputQuestion = {
    id: 'language',
    header: 'Language',
    question: 'Which language should I use?',
    isOther: false,
    isSecret: false,
    options: [
      {
        label: 'TypeScript',
        description: 'Use the existing app stack.',
      },
      {
        label: 'Rust',
        description: 'Use the OpenCode runtime.',
      },
    ],
  };

  it('rejects arbitrary free-form answers for fixed-choice questions', () => {
    expect(
      resolveAcpRequestUserInputAnswer(fixedChoiceQuestion, 'Go'),
    ).toBeNull();

    expect(
      parseAcpRequestUserInputReply({ questions: [fixedChoiceQuestion] }, 'Go'),
    ).toBeNull();
  });

  it('still accepts fixed-choice answers by number or label', () => {
    expect(resolveAcpRequestUserInputAnswer(fixedChoiceQuestion, '2')).toBe(
      'Rust',
    );

    expect(
      resolveAcpRequestUserInputAnswer(fixedChoiceQuestion, 'TypeScript'),
    ).toBe('TypeScript');
  });

  it('accepts custom answers when the question allows other', () => {
    expect(
      resolveAcpRequestUserInputAnswer(
        { ...fixedChoiceQuestion, isOther: true },
        'Go',
      ),
    ).toBe('Go');
  });

  it('parses more than three ordered answers for multi-question prompts', () => {
    const questions: AcpRequestUserInputQuestion[] = [
      fixedChoiceQuestion,
      {
        id: 'surface',
        header: 'Surface',
        question: 'Which surface should I update first?',
        isOther: false,
        isSecret: false,
        options: [
          {
            label: 'Web',
            description: 'Update the dashboard first.',
          },
          {
            label: 'Slack',
            description: 'Update the Slack workflow first.',
          },
        ],
      },
      {
        id: 'validation',
        header: 'Validation',
        question: 'How much validation should I run?',
        isOther: false,
        isSecret: false,
        options: [
          {
            label: 'Targeted',
            description: 'Run checks around the changed surface.',
          },
          {
            label: 'Full',
            description: 'Run the whole suite.',
          },
        ],
      },
      {
        id: 'rollout',
        header: 'Rollout',
        question: 'How should I roll this out?',
        isOther: false,
        isSecret: false,
        options: [
          {
            label: 'Immediate',
            description: 'Ship it with the main change.',
          },
          {
            label: 'Follow-up',
            description: 'Stage it for later.',
          },
        ],
      },
    ];

    expect(
      parseAcpRequestUserInputReply(
        { questions },
        ['Rust', 'Slack', 'Targeted', 'Follow-up'].join('\n'),
      ),
    ).toEqual({
      resolution: 'submitted',
      answers: {
        language: { answers: ['Rust'] },
        surface: { answers: ['Slack'] },
        validation: { answers: ['Targeted'] },
        rollout: { answers: ['Follow-up'] },
      },
      usedFreeTextOptionFallback: false,
    });
  });

  it('flags free-text isOther fallback answers to options questions', () => {
    const parsed = parseAcpRequestUserInputReply(
      {
        questions: [
          {
            id: 'strategy',
            header: 'Strategy',
            question: 'Which rate-limiting strategy should I target?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Fixed window', description: 'Simpler.' },
              { label: 'Sliding window', description: 'Smoother.' },
            ],
          },
        ],
      },
      'whats the difference in practice? which one is easier to test?',
    );

    expect(parsed?.resolution).toBe('submitted');
    expect(parsed?.usedFreeTextOptionFallback).toBe(true);
  });

  it('does not flag numbered multi-question replies with custom answers', () => {
    const questions = [
      {
        id: 'strategy',
        header: 'Strategy',
        question: 'Which strategy?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Fixed window', description: 'Simpler.' },
          { label: 'Sliding window', description: 'Smoother.' },
        ],
      },
      {
        id: 'store',
        header: 'Store',
        question: 'Which backing store?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'In-memory', description: 'Simplest.' },
          { label: 'Redis', description: 'Shared.' },
        ],
      },
    ];

    // Explicit "1: ..." numbering is answer-shaped, so a deliberate custom
    // answer inside it must not reclassify the batch as an interjection.
    const numbered = parseAcpRequestUserInputReply(
      { questions },
      '1: fixed window\n2: use postgres instead',
    );
    expect(numbered?.answers.store?.answers[0]).toBe('use postgres instead');
    expect(numbered?.usedFreeTextOptionFallback).toBe(false);

    // Unnumbered N-line text that only matches via the isOther fallback keeps
    // the interjection flag.
    const plainLines = parseAcpRequestUserInputReply(
      { questions },
      'hmm not sure yet\nwhat would you recommend?',
    );
    expect(plainLines?.usedFreeTextOptionFallback).toBe(true);
  });

  it('does not flag option-label answers or open-question free text', () => {
    const optionsQuestion = {
      id: 'strategy',
      header: 'Strategy',
      question: 'Which rate-limiting strategy should I target?',
      isOther: true,
      isSecret: false,
      options: [
        { label: 'Fixed window', description: 'Simpler.' },
        { label: 'Sliding window', description: 'Smoother.' },
      ],
    };

    expect(
      parseAcpRequestUserInputReply(
        { questions: [optionsQuestion] },
        'sliding window',
      )?.usedFreeTextOptionFallback,
    ).toBe(false);

    expect(
      parseAcpRequestUserInputReply({ questions: [optionsQuestion] }, '1')
        ?.usedFreeTextOptionFallback,
    ).toBe(false);

    expect(
      parseAcpRequestUserInputReply(
        {
          questions: [
            {
              id: 'name',
              header: 'Name',
              question: 'What should the feature flag be called?',
              isOther: true,
              isSecret: false,
            },
          ],
        },
        'use rate_limit_v2 please',
      )?.usedFreeTextOptionFallback,
    ).toBe(false);
  });
});

describe('parseLinkedReviewResults', () => {
  it('extracts current_head_sha from review_result linked review handoffs', () => {
    expect(
      parseLinkedReviewResults(
        [
          '<review_result>',
          '<review_kind>sync</review_kind>',
          '<outcome>findings_remain</outcome>',
          '<finding_count>2</finding_count>',
          '<current_head_sha>abc123def456</current_head_sha>',
          '<summary>2 actionable findings still remain after the latest push.</summary>',
          '</review_result>',
        ].join('\n'),
      ),
    ).toMatchObject({
      reviewKind: 'sync',
      outcome: 'findings_remain',
      findingCount: 2,
      currentHeadSha: 'abc123def456',
      summary: '2 actionable findings still remain after the latest push.',
    });
  });

  it('still accepts legacy code-review-results linked review handoffs', () => {
    expect(
      parseLinkedReviewResults(
        [
          '<code-review-results type="send">',
          '<review_kind>initial</review_kind>',
          '<outcome>clean</outcome>',
          '<summary>No review findings remain.</summary>',
          '</code-review-results>',
        ].join('\n'),
      ),
    ).toMatchObject({
      reviewKind: 'initial',
      outcome: 'clean',
      summary: 'No review findings remain.',
    });
  });

  it('recognizes both current and legacy linked review wrappers exactly', () => {
    expect(
      isLinkedReviewResultsMessage(
        '<review_result><summary>Clean</summary></review_result>',
      ),
    ).toBe(true);
    expect(
      isLinkedReviewResultsMessage(
        '<code-review-results><summary>Clean</summary></code-review-results>',
      ),
    ).toBe(true);
    expect(
      isLinkedReviewResultsMessage(
        'prefix <review_result><summary>Clean</summary></review_result>',
      ),
    ).toBe(false);
  });
});

describe('truncateAcpOutputText', () => {
  it('returns original text when within the limit', () => {
    const result = truncateAcpOutputText('small output', 100);

    expect(result.text).toBe('small output');
    expect(result.truncation).toBeNull();
  });

  it('truncates oversized text with head/tail strategy', () => {
    const text = 'x'.repeat(500);
    const result = truncateAcpOutputText(text, 120);

    expect(result.text).toContain('[output truncated: kept 120 of 500 chars]');
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.truncation).toEqual({
      originalChars: 500,
      keptChars: 120,
      strategy: 'head_tail',
    });
  });

  it('preserves head and tail of the original text', () => {
    const text = 'HEAD_' + 'x'.repeat(490) + '_TAIL';
    const result = truncateAcpOutputText(text, 120);

    expect(result.text).toContain('HEAD_');
    expect(result.text).toContain('_TAIL');
  });
});

describe('sanitizeAcpToolCallUpdate', () => {
  it('normalizes rawOutput into output and truncates', () => {
    const hugeOutput = 'x'.repeat(300);
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        running: false,
        rawOutput: hugeOutput,
      },
      { maxOutputChars: 120 },
    );

    expect(result.update.output).toContain(
      '[output truncated: kept 120 of 300 chars]',
    );
    expect(result.update).not.toHaveProperty('rawOutput');
    expect(result.update.sessionUpdate).toBe('tool_call_update');
    expect(result.update.toolCallId).toBe('call-1');
    expect(result.truncation).not.toBeNull();
  });

  it('normalizes rawOutput object with well-known fields', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        rawOutput: { formatted_output: 'hello world' },
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update.output).toBe('hello world');
    expect(result.update).not.toHaveProperty('rawOutput');
    expect(result.truncation).toBeNull();
  });

  it('preserves all non-output fields', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        kind: 'execute',
        status: 'completed',
        running: false,
        exitCode: 0,
        rawInput: { command: ['ls', '-la'] },
        rawOutput: 'small',
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-2',
      kind: 'execute',
      status: 'completed',
      running: false,
      exitCode: 0,
      rawInput: { command: ['ls', '-la'] },
      output: 'small',
    });
  });

  it('preserves exitCode derived from rawOutput when lifting output', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        rawOutput: {
          formatted_output: 'done',
          exitCode: 7,
        },
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update.output).toBe('done');
    expect(result.update.exitCode).toBe(7);
    expect(result.update).not.toHaveProperty('rawOutput');
  });

  it('removes content field alongside rawOutput', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        output: 'from output',
        content: [{ type: 'text', text: 'from content' }],
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update.output).toBe('from output');
    expect(result.update).not.toHaveProperty('content');
  });

  it('falls through empty output to rawOutput', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        output: '',
        rawOutput: 'actual output',
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update.output).toBe('actual output');
    expect(result.update).not.toHaveProperty('rawOutput');
  });

  it('falls through whitespace-only output to rawOutput', () => {
    const result = sanitizeAcpToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        output: '   ',
        rawOutput: 'actual output',
      },
      { maxOutputChars: 1000 },
    );

    expect(result.update.output).toBe('actual output');
  });

  it('uses default max chars when no options provided', () => {
    const text = 'x'.repeat(ACP_API_TOOL_OUTPUT_MAX_CHARS + 100);
    const result = sanitizeAcpToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      rawOutput: text,
    });

    expect(result.truncation).not.toBeNull();
    expect(result.truncation?.keptChars).toBe(ACP_API_TOOL_OUTPUT_MAX_CHARS);
  });
});

describe('sanitizeAcpToolResultPayload', () => {
  it('truncates oversized output', () => {
    const result = sanitizeAcpToolResultPayload(
      { output: 'x'.repeat(260) },
      { maxOutputChars: 120 },
    );

    expect(result.payload.output).toContain(
      '[output truncated: kept 120 of 260 chars]',
    );
    expect(result.truncation).not.toBeNull();
  });

  it('passes through payloads with no output', () => {
    const payload = { kind: 'execute', command: 'ls' };
    const result = sanitizeAcpToolResultPayload(payload, {
      maxOutputChars: 120,
    });

    expect(result.payload).toBe(payload);
    expect(result.truncation).toBeNull();
  });

  it('passes through payloads with small output', () => {
    const payload = { output: 'small' };
    const result = sanitizeAcpToolResultPayload(payload, {
      maxOutputChars: 120,
    });

    expect(result.payload).toBe(payload);
    expect(result.truncation).toBeNull();
  });
});

describe('sanitizeEnvelopeFields', () => {
  it('sanitizes tool_call_update envelopes', () => {
    const hugeOutput = 'x'.repeat(200);
    const result = sanitizeEnvelopeFields(
      'roomote_runtime.output.tool_call_update.5',
      [],
      { source: 'test' },
      {
        updateType: 'tool_call_update',
        update: {
          sessionUpdate: 'tool_call_update',
          rawOutput: hugeOutput,
        },
      },
      { maxOutputChars: 50 },
    );

    const update = result.payload?.update as Record<string, unknown>;
    expect(update.output).toContain('[output truncated');
    expect(update).not.toHaveProperty('rawOutput');
    expect(result.metadata?.truncation).toMatchObject({
      originalChars: 200,
      keptChars: 50,
    });
  });

  it('sanitizes tool_result envelopes', () => {
    const result = sanitizeEnvelopeFields(
      'roomote_runtime.tool_result',
      [{ type: 'text', text: 'old' }],
      null,
      { output: 'x'.repeat(200) },
      { maxOutputChars: 50 },
    );

    expect(result.payload?.output).toContain('[output truncated');
    expect(result.contentBlocks).toEqual([
      { type: 'text', text: result.payload?.output },
    ]);
    expect(result.metadata?.truncation).not.toBeNull();
  });

  it('passes through non-tool event types unchanged', () => {
    const contentBlocks = [{ type: 'text' as const, text: 'hello' }];
    const metadata = { source: 'test' };
    const payload = { text: 'hello' };

    const result = sanitizeEnvelopeFields(
      'roomote_runtime.assistant_message',
      contentBlocks,
      metadata,
      payload,
    );

    expect(result.contentBlocks).toBe(contentBlocks);
    expect(result.metadata).toBe(metadata);
    expect(result.payload).toBe(payload);
  });

  it('handles null payload gracefully', () => {
    const result = sanitizeEnvelopeFields(
      'roomote_runtime.output.tool_call_update.1',
      [],
      null,
      null,
    );

    expect(result.payload).toBeNull();
    expect(result.metadata).toBeNull();
  });
});

describe('task_cancelled marker', () => {
  it('maps the task_cancelled event type to its own message kind', () => {
    expect(inferAcpMessageKind(ACP_ENVELOPE_EVENT_TYPES.TaskCancelled)).toBe(
      'task_cancelled',
    );
  });

  it('parses a task_cancelled payload with attribution', () => {
    expect(
      parseAcpTaskCancelledPayload({
        sessionId: 'ses_1',
        cancelledByName: 'Daniel',
        source: 'web',
      }),
    ).toEqual({
      sessionId: 'ses_1',
      cancelledByName: 'Daniel',
      source: 'web',
    });
  });

  it('parses an attribution-less payload and rejects one without a session', () => {
    expect(parseAcpTaskCancelledPayload({ sessionId: 'ses_1' })).toEqual({
      sessionId: 'ses_1',
    });
    expect(parseAcpTaskCancelledPayload({ cancelledByName: 'Daniel' })).toBe(
      null,
    );
    expect(parseAcpTaskCancelledPayload(null)).toBe(null);
  });
});
