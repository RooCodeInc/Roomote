import { createOpenCodeExitCertificateCollector } from './exit-certificate';

describe('createOpenCodeExitCertificateCollector', () => {
  it('captures exit facts with the tagged output tail', () => {
    const collector = createOpenCodeExitCertificateCollector();

    collector.appendLine('stdout', 'server listening');
    collector.appendLine('stderr', 'panic: something broke');

    const certificate = collector.build({ exitCode: 137, signal: 'SIGKILL' });

    expect(certificate.exitCode).toBe(137);
    expect(certificate.signal).toBe('SIGKILL');
    expect(certificate.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(certificate.outputTail).toEqual([
      '[stdout] server listening',
      '[stderr] panic: something broke',
    ]);
  });

  it('keeps only the most recent lines and caps line length', () => {
    const collector = createOpenCodeExitCertificateCollector();

    for (let i = 0; i < 80; i += 1) {
      collector.appendLine('stderr', `line ${i} ${'x'.repeat(400)}`);
    }

    const certificate = collector.build({ exitCode: 1, signal: null });

    expect(certificate.outputTail).toHaveLength(50);
    expect(certificate.outputTail[0]).toContain('line 30');
    expect(certificate.outputTail[49]).toContain('line 79');
    for (const line of certificate.outputTail) {
      expect(line.length).toBeLessThanOrEqual(320);
    }
  });

  it('skips blank lines and never fails on missing memory accounting', () => {
    const collector = createOpenCodeExitCertificateCollector();

    collector.appendLine('stdout', '   ');
    collector.appendLine('stdout', '');

    const certificate = collector.build({ exitCode: null, signal: 'SIGTERM' });

    expect(certificate.outputTail).toEqual([]);
    // /proc/meminfo may not exist on the test host; the snapshot is either a
    // complete reading or null, never a throw.
    if (certificate.memory !== null) {
      expect(certificate.memory.memTotalKb).toBeGreaterThan(0);
      expect(certificate.memory.workerRssBytes).toBeGreaterThan(0);
    }
  });
});
