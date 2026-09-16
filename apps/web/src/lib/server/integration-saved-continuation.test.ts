import { buildRemoteMcpConnectedContinuation } from './integration-saved-continuation';

describe('buildRemoteMcpConnectedContinuation', () => {
  it('continues automatically with a concise tool summary', () => {
    const continuation = buildRemoteMcpConnectedContinuation('deepwiki');

    expect(continuation).toContain('report the tool count');
    expect(continuation).toContain('two or three tools most relevant');
    expect(continuation).toContain('continue that request automatically');
    expect(continuation).toContain('do not dump the full tool list');
    expect(continuation).toContain('Never ask the human to send a follow-up');
    expect(continuation).not.toContain('refresh the integration catalog');
    expect(continuation).not.toContain("list this server's tools");
  });
});
