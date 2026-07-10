import {
  isExpectedSubprocessExit,
  markExpectedSubprocessExitIfAlive,
} from './expected-exit';

describe('markExpectedSubprocessExitIfAlive', () => {
  it('marks a live subprocess as an expected exit', () => {
    const subprocess = { exitCode: null, killed: false };

    expect(markExpectedSubprocessExitIfAlive(subprocess)).toBe(true);
    expect(isExpectedSubprocessExit(subprocess)).toBe(true);
  });

  it('does not mark a subprocess that already exited on its own', () => {
    // A crash surfaces as a disconnect first, and the disconnect cleanup then
    // kills the (already dead) process. That teardown must not suppress the
    // crash's death certificate.
    const crashed = { exitCode: 137, killed: false };

    expect(markExpectedSubprocessExitIfAlive(crashed)).toBe(false);
    expect(isExpectedSubprocessExit(crashed)).toBe(false);
  });

  it('does not mark a subprocess that was already signalled', () => {
    const signalled = { exitCode: null, killed: true };

    expect(markExpectedSubprocessExitIfAlive(signalled)).toBe(false);
    expect(isExpectedSubprocessExit(signalled)).toBe(false);
  });
});
