import { scrubForMemoryCheck } from '../memory-check-scrub';

describe('scrubForMemoryCheck', () => {
  it('removes credentials and structured personal data', () => {
    const scrubbed = scrubForMemoryCheck(
      [
        `token ghp_${'a'.repeat(36)}`,
        'mail dana.lee+billing@example.co.uk about it',
        'call +44 20 7946 0958 or (415) 555-0132',
        'ssn 078-05-1120',
        'card 4111 1111 1111 1111',
      ].join('\n'),
    );

    expect(scrubbed).not.toContain('ghp_');
    expect(scrubbed).toContain('mail [email address] about it');
    expect(scrubbed).toContain('call [phone number] or [phone number]');
    expect(scrubbed).toContain('ssn [id number]');
    expect(scrubbed).toContain('card [card number]');
  });

  it('keeps dates, versions, counts, and references readable', () => {
    const text =
      'On 2026-09-21 we shipped 1.12.4, closed #3059, saw 340 queries in 1200 ms, and kept the 60s TTL at port 3000.';

    expect(scrubForMemoryCheck(text)).toBe(text);
  });
});
