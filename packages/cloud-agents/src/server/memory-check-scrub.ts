import { redactBrainText } from '@roomote/communication/redact-brain-text';

const EMAIL_PATTERN =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
const NATIONAL_ID_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
/** A digit run with phone or card punctuation; classified by its digits. */
const NUMBER_CANDIDATE_PATTERN = /(?:\+|\()?\d[\d \t().-]{6,}\d/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;

  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);

    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  return sum % 10 === 0;
}

function scrubNumber(candidate: string): string {
  const digits = candidate.replace(/\D/g, '');

  if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
    return '[card number]';
  }

  // Dates, versions, and short identifiers stay readable; anything long
  // enough to dial does not. A false positive only costs a placeholder.
  const dialable = candidate.startsWith('+')
    ? digits.length >= 8
    : digits.length >= 10;

  return dialable && digits.length <= 15 ? '[phone number]' : candidate;
}

/**
 * Scrub text before the after-the-turn memory checks send it to the decision
 * or helper model. Those checks run on turns nobody chose to share with
 * another provider, and their own "is this sensitive" verdict arrives only
 * after the text has left, so what can be recognized locally is removed
 * first: credential shapes (the same patterns Memory ingestion applies) and
 * structured personal data. Names and free-form details cannot be recognized
 * locally and still rely on the verdict to keep them out of Memory.
 */
export function scrubForMemoryCheck(text: string): string {
  return redactBrainText(text)
    .replace(EMAIL_PATTERN, '[email address]')
    .replace(NATIONAL_ID_PATTERN, '[id number]')
    .replace(NUMBER_CANDIDATE_PATTERN, scrubNumber);
}
