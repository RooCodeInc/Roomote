import {
  manageIntegrationConnectionInputSchema as schema,
  MANAGE_INTEGRATION_CONNECTION_TOOL,
} from './integration-connection';

it.each([
  'list',
  'inspect',
  'configure',
  'test',
  'permissions',
  'request_auth',
])('accepts action %s', (action) => {
  expect(schema.parse({ action })).toEqual({ action });
});

it.each(['headers', 'credentials', 'token', 'stdio', 'command', 'env'])(
  'rejects credential/stdio field %s',
  (field) => {
    expect(
      schema.safeParse({ action: 'configure', [field]: 'secret' }).success,
    ).toBe(false);
  },
);

it.each([
  'https://user:secret@example.com/mcp',
  'https://@example.com/mcp',
  'https://example.com?token=secret',
  'https://example.com#secret',
  'https://example.com?',
  'https://example.com#',
  'file:///secret',
  'not a url',
])('rejects unsafe endpoint without echo: %s', (url) => {
  const parsed = schema.safeParse({ action: 'configure', url });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.message).not.toContain(url);
});

it('publishes a strict shared management contract', () => {
  expect(MANAGE_INTEGRATION_CONNECTION_TOOL.inputSchema).toBe(schema);
  expect(
    schema.parse({
      action: 'configure',
      url: 'https://example.com/mcp',
      authType: 'static_headers',
      enabled: false,
      disabledTools: [],
    }),
  ).toMatchObject({ enabled: false });
});
