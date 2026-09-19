import { MockSlackServer } from '../mock-slack-server';
import { SlackNotifier } from '../slack-notifier';
import {
  buildSlackThreadReplyFooterBlock,
  removeSlackThreadReplyFooter,
} from '../thread-reply-footer-ops';

const input = { channel: 'CLOCAL', threadTs: '1.000', messageTs: '1.000' };
const body = (text: string) => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
});
let server: MockSlackServer;
let notifier: SlackNotifier;
let originalUrl: string | undefined;

beforeEach(async () => {
  originalUrl = process.env.SLACK_API_BASE_URL;
  server = new MockSlackServer({
    state: {
      team: { id: 'TLOCAL', domain: 'local' },
      channels: [{ id: 'CLOCAL', name: 'local', isMember: true }],
      users: [{ id: 'UBOT', name: 'bot' }],
      messages: [
        {
          channel: 'CLOCAL',
          ts: '1.000',
          user: 'UBOT',
          type: 'message',
          text: 'original',
          blocks: [body('original')],
        },
      ],
    },
  });
  process.env.SLACK_API_BASE_URL = `${await server.start()}/api/`;
  notifier = new SlackNotifier('fixture-a');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  if (originalUrl === undefined) delete process.env.SLACK_API_BASE_URL;
  else process.env.SLACK_API_BASE_URL = originalUrl;
});

it('removing a footer preserves a body updated by another notifier', async () => {
  const footer = buildSlackThreadReplyFooterBlock({
    footerText: 'Reply anytime · <http://localhost/fixture|Open in Roomote>',
  });
  const state = server.getState();
  state.messages![0]!.blocks = [body('original'), footer];
  server.setState(state);
  await notifier.getMessageBlocks(input);
  await new SlackNotifier('fixture-b').updateMessage({
    channel: input.channel,
    ts: input.messageTs,
    message: { blocks: [body('new body'), footer] },
  });
  await removeSlackThreadReplyFooter({ slack: notifier, ...input });
  expect(server.getState().messages?.[0]?.blocks).toEqual([body('new body')]);
});

it('existence checks observe a deletion by another notifier immediately', async () => {
  expect(await notifier.hasMessageInThread(input)).toBe(true);
  await new SlackNotifier('fixture-b').deleteMessage({
    channel: input.channel,
    ts: input.messageTs,
  });
  expect(await notifier.hasMessageInThread(input)).toBe(false);
});

it('shares thread snapshots across identical reads but not notifier instances', async () => {
  const requests = vi.spyOn(globalThis, 'fetch');
  const read = () => notifier.fetchThreadMessages(input);
  await Promise.all([read(), read(), read()]);
  await read();
  const replyCalls = () =>
    requests.mock.calls.filter(([url]) =>
      String(url).includes('/conversations.replies'),
    ).length;
  expect(replyCalls()).toBe(1);
  await new SlackNotifier('fixture-b').fetchThreadMessages(input);
  expect(replyCalls()).toBe(2);
});

it('invalidates cached thread snapshots after updates and deletions', async () => {
  expect((await notifier.fetchThreadMessages(input))[0]?.text).toBe('original');
  await notifier.updateMessage({
    channel: input.channel,
    ts: input.messageTs,
    message: { text: 'updated', blocks: [body('updated')] },
  });
  expect((await notifier.fetchThreadMessages(input))[0]?.text).toBe('updated');
  await notifier.deleteMessage({ channel: input.channel, ts: input.messageTs });
  expect(await notifier.fetchThreadMessages(input)).toEqual([]);
});

it('refreshes prefetched context after starting, appending and stopping a stream', async () => {
  expect(await notifier.fetchThreadMessages(input)).toHaveLength(1);
  const ts = await notifier.startMessageStream({
    channel: input.channel,
    threadTs: input.threadTs,
    recipientTeamId: 'TLOCAL',
    recipientUserId: 'UBOT',
    markdownText: 'first',
  });
  expect(ts).not.toBeNull();
  const streamInput = { channel: input.channel, ts: ts! };
  const streamText = async () =>
    (await notifier.fetchThreadMessages(input)).find(
      (message) => message.ts === ts,
    )?.text;
  expect(await streamText()).toBe('first');
  expect(
    await notifier.appendMessageStream({
      ...streamInput,
      markdownText: ' second',
    }),
  ).toBe(true);
  expect(await streamText()).toBe('first second');
  expect(
    await notifier.stopMessageStream({
      ...streamInput,
      markdownText: ' final',
    }),
  ).toBe(true);
  expect(await streamText()).toBe('first second final');
});
