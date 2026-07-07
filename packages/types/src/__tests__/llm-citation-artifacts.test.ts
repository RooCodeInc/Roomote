import {
  deepStripCitations,
  stripLlmCitationArtifacts,
} from '../llm-citation-artifacts';

describe('llm citation artifacts', () => {
  it('strips OpenAI unicode citation markers', () => {
    expect(
      stripLlmCitationArtifacts('Answer \uE200cite\uE202turn1search0\uE201'),
    ).toBe('Answer');
  });

  it('strips multi-reference citation markers used by web open/find results', () => {
    expect(
      stripLlmCitationArtifacts(
        'Answer \uE200cite\uE202turn0open0\uE202turn0find0\uE201 done',
      ),
    ).toBe('Answer done');
  });

  it('strips bare citation ids after unicode is removed upstream', () => {
    expect(stripLlmCitationArtifacts('Answer citeturn1search0 end')).toBe(
      'Answer end',
    );
  });

  it('passes normal text through unchanged', () => {
    expect(stripLlmCitationArtifacts('Normal text only.')).toBe(
      'Normal text only.',
    );
  });

  it('preserves leading and trailing whitespace on clean strings', () => {
    expect(stripLlmCitationArtifacts('  padded text  ')).toBe(
      '  padded text  ',
    );
  });

  it('removes punctuation-adjacent bare citation artifacts cleanly', () => {
    expect(stripLlmCitationArtifacts('Answer citeturn1search0.')).toBe(
      'Answer.',
    );
  });

  it('preserves space when citation follows sentence-ending punctuation', () => {
    expect(
      stripLlmCitationArtifacts('Answer. citeturn1search0 Next sentence'),
    ).toBe('Answer. Next sentence');
  });

  it('preserves space when citation follows period with unicode markers', () => {
    expect(
      stripLlmCitationArtifacts(
        'The site is indexed. \uE200cite\uE202turn0search0\uE202turn0search1\uE201 Google shows results.',
      ),
    ).toBe('The site is indexed. Google shows results.');
  });

  it('preserves spacing when back-to-back bare citations are stripped', () => {
    expect(
      stripLlmCitationArtifacts(
        'Answer citeturn1search0 citeturn2search1 next',
      ),
    ).toBe('Answer next');
  });

  it('preserves spacing when three bare citations are stripped in a row', () => {
    expect(
      stripLlmCitationArtifacts(
        'A citeturn0search0 citeturn1search0 citeturn2search0 B',
      ),
    ).toBe('A B');
  });

  it('preserves spacing when consecutive unicode and bare citations are stripped', () => {
    expect(
      stripLlmCitationArtifacts(
        'X \uE200cite\uE202turn0search0\uE201 citeturn1search0 Y',
      ),
    ).toBe('X Y');
  });

  it('preserves trailing whitespace when a citation is stripped at the end', () => {
    expect(stripLlmCitationArtifacts('  padded text citeturn0search0  ')).toBe(
      '  padded text  ',
    );
  });

  it('preserves tabs around stripped citations', () => {
    expect(stripLlmCitationArtifacts('Col1\tciteturn0search0\tCol2')).toBe(
      'Col1\tCol2',
    );
  });

  it('preserves double spaces around stripped citations', () => {
    expect(stripLlmCitationArtifacts('A  citeturn0search0  B')).toBe('A  B');
  });

  it('recursively strips nested strings', () => {
    expect(
      deepStripCitations({
        text: 'Answer \uE200cite\uE202turn1search0\uE201',
        nested: ['keep', { text: 'citeturn2search1 done' }],
      }),
    ).toEqual({
      text: 'Answer',
      nested: ['keep', { text: 'done' }],
    });
  });

  it('preserves references when nothing changes', () => {
    const value = {
      text: 'Normal text only.',
      nested: ['still clean'],
    };

    expect(deepStripCitations(value)).toBe(value);
    expect(deepStripCitations(value.nested)).toBe(value.nested);
  });
});
