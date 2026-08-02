// pnpm test src/lib/__tests__/formatters.test.ts

import { formatNumber, formatCurrency, formatTimeZone } from '../formatters';

describe('formatNumber', () => {
  it('should return empty string for undefined values', () => {
    expect(formatNumber(undefined)).toBe('');
  });

  it('should return "0" for zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('should return the number as string for values less than 1000', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(123)).toBe('123');
    expect(formatNumber(999)).toBe('999');
  });

  it('should format thousands with K suffix', () => {
    expect(formatNumber(1000)).toBe('1.0K');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(2345)).toBe('2.3K');
    expect(formatNumber(999999)).toBe('1000.0K');
  });

  it('should format millions with M suffix', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
    expect(formatNumber(1500000)).toBe('1.5M');
    expect(formatNumber(2345678)).toBe('2.3M');
    expect(formatNumber(999999999)).toBe('1000.0M');
  });

  it('should format billions with B suffix', () => {
    expect(formatNumber(1000000000)).toBe('1.0B');
    expect(formatNumber(1500000000)).toBe('1.5B');
    expect(formatNumber(2345678901)).toBe('2.3B');
    expect(formatNumber(999999999999)).toBe('1000.0B');
  });

  it('should format trillions with T suffix', () => {
    expect(formatNumber(1000000000000)).toBe('1.0T');
    expect(formatNumber(1500000000000)).toBe('1.5T');
    expect(formatNumber(2345678901234)).toBe('2.3T');
  });

  it('should handle negative numbers correctly', () => {
    expect(formatNumber(-1000)).toBe('-1.0K');
    expect(formatNumber(-1500000)).toBe('-1.5M');
    expect(formatNumber(-2345678901)).toBe('-2.3B');
    expect(formatNumber(-1500000000000)).toBe('-1.5T');
  });
});

describe('formatCurrency', () => {
  it('should return empty string for undefined values', () => {
    expect(formatCurrency(undefined)).toBe('');
  });

  it('should format USD currency correctly', () => {
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(1)).toBe('$1.00');
    expect(formatCurrency(1.5)).toBe('$1.50');
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
  });

  it('should handle negative currency values correctly', () => {
    expect(formatCurrency(-1)).toBe('-$1.00');
    expect(formatCurrency(-1234.56)).toBe('-$1,234.56');
  });

  it('should format different currencies correctly', () => {
    const eurFormat = formatCurrency(1234.56, {
      currency: 'EUR',
      locale: 'de-DE',
    });
    expect(eurFormat).toContain('€');
    expect(eurFormat).toContain('1.234,56');

    const jpyFormat = formatCurrency(1234.56, {
      currency: 'JPY',
      locale: 'ja-JP',
    });
    expect(jpyFormat).toContain('￥');
    expect(jpyFormat).toMatch(
      /1,234\.56|1,235|￥1,234\.56|￥1,235|1,234\.56￥|1,235￥/,
    );

    const gbpFormat = formatCurrency(1234.56, {
      currency: 'GBP',
      locale: 'en-GB',
    });
    expect(gbpFormat).toContain('£');
    expect(gbpFormat).toContain('1,234.56');
  });

  it('should round to 2 decimal places', () => {
    expect(formatCurrency(1.234)).toBe('$1.23');
    expect(formatCurrency(1.235)).toBe('$1.24');
    expect(formatCurrency(1.2)).toBe('$1.20');
  });

  it('should handle compact formatting correctly', () => {
    // When compact is true, the formatting may vary based on browser implementation
    // But we can test that it doesn't show unnecessary decimals for whole numbers
    const compactFormat = formatCurrency(100, { compact: true });
    expect(compactFormat).toContain('$100');

    // Compact format for decimal values might show decimals
    const compactDecimalFormat = formatCurrency(100.5, { compact: true });
    expect(compactDecimalFormat).toContain('$100');

    // When compact is false (default), always show 2 decimal places
    const nonCompactFormat = formatCurrency(100, { compact: false });
    expect(nonCompactFormat).toBe('$100.00');
  });

  it('should accept options object with partial properties', () => {
    // Only currency specified
    const eurOnly = formatCurrency(100, { currency: 'EUR' });
    expect(eurOnly).toContain('€');

    // Only locale specified
    const localeOnly = formatCurrency(1234.56, { locale: 'de-DE' });
    expect(localeOnly).toContain('$'); // Still USD
    expect(localeOnly).toContain('1.234,56'); // German formatting

    // Only compact specified
    const compactOnly = formatCurrency(100, { compact: true });
    expect(compactOnly).toContain('$100');
  });
});

describe('formatTimeZone', () => {
  it('replaces underscores with spaces', () => {
    expect(formatTimeZone('Africa/Addis_Ababa')).toBe('Africa/Addis Ababa');
    expect(formatTimeZone('America/New_York')).toBe('America/New York');
    expect(formatTimeZone('America/Argentina/Rio_Gallegos')).toBe(
      'America/Argentina/Rio Gallegos',
    );
  });

  it('leaves identifiers without underscores unchanged', () => {
    expect(formatTimeZone('UTC')).toBe('UTC');
    expect(formatTimeZone('Europe/London')).toBe('Europe/London');
  });
});
