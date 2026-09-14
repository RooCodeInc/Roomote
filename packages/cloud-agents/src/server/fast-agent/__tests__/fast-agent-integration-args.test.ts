import { describe, expect, it } from 'vitest';

import { describeUnknownIntegrationArguments } from '../fast-agent-integration-args';

const call = {
  integrationId: 'roomote',
  toolName: 'get_chat_channel_messages',
};
const schema = {
  type: 'object',
  properties: {
    channel: { type: 'string' },
    oldest: { type: 'string' },
    latest: { type: 'string' },
  },
  additionalProperties: false,
};

describe('describeUnknownIntegrationArguments', () => {
  it('accepts arguments whose keys are all declared', () => {
    expect(
      describeUnknownIntegrationArguments(
        call,
        { channel: 'C1', oldest: '2026-09-01' },
        schema,
      ),
    ).toBeNull();
    expect(describeUnknownIntegrationArguments(call, {}, schema)).toBeNull();
  });

  it('names an undeclared key and the accepted ones', () => {
    expect(
      describeUnknownIntegrationArguments(call, { chanel: 'C1' }, schema),
    ).toBe(
      'Unknown argument key "chanel" for roomote tool get_chat_channel_messages. This tool accepts: channel, oldest, latest.',
    );
  });

  it('explains the args wrapper convention when args is the stray key', () => {
    expect(
      describeUnknownIntegrationArguments(
        call,
        { args: '{"oldest": "2026-09-07T00:00:00Z"}' },
        schema,
      ),
    ).toBe(
      'Unknown argument key "args" for roomote tool get_chat_channel_messages. This tool accepts: channel, oldest, latest. Do not wrap arguments in an "args" field; that convention is only for call_integration_tool. Pass each argument at the top level.',
    );
  });

  it('lists every unknown key', () => {
    expect(
      describeUnknownIntegrationArguments(
        call,
        { channel: 'C1', from: 'a', to: 'b' },
        schema,
      ),
    ).toBe(
      'Unknown argument keys "from", "to" for roomote tool get_chat_channel_messages. This tool accepts: channel, oldest, latest.',
    );
  });

  it('describes a tool that takes no arguments', () => {
    expect(
      describeUnknownIntegrationArguments(
        { integrationId: 'roomote', toolName: 'get_about_me' },
        { args: '{}' },
        { type: 'object', properties: {}, additionalProperties: false },
      ),
    ).toBe(
      'Unknown argument key "args" for roomote tool get_about_me. This tool takes no arguments. Do not wrap arguments in an "args" field; that convention is only for call_integration_tool. Pass each argument at the top level.',
    );
  });

  it('allows args when the tool schema declares it', () => {
    expect(
      describeUnknownIntegrationArguments(
        { integrationId: 'shell', toolName: 'run' },
        { args: ['--version'], command: 'node' },
        {
          type: 'object',
          properties: { command: { type: 'string' }, args: { type: 'array' } },
          additionalProperties: false,
        },
      ),
    ).toBeNull();
  });

  it('only judges schemas that explicitly close the object', () => {
    const args = { anything: 1 };
    const { additionalProperties: _closed, ...open } = schema;
    expect(
      describeUnknownIntegrationArguments(call, args, undefined),
    ).toBeNull();
    expect(
      describeUnknownIntegrationArguments(call, args, { type: 'object' }),
    ).toBeNull();
    expect(describeUnknownIntegrationArguments(call, args, open)).toBeNull();
    expect(
      describeUnknownIntegrationArguments(call, args, {
        ...open,
        additionalProperties: true,
      }),
    ).toBeNull();
    expect(
      describeUnknownIntegrationArguments(call, args, {
        ...open,
        additionalProperties: { type: 'string' },
      }),
    ).toBeNull();
    expect(
      describeUnknownIntegrationArguments(call, args, {
        ...schema,
        patternProperties: { '^x-': {} },
      }),
    ).toBeNull();
    expect(
      describeUnknownIntegrationArguments(call, args, schema),
    ).not.toBeNull();
  });
});
