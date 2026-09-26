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

  it('removes punctuation-adjacent bare citation artifacts cleanly', () => {
    expect(stripLlmCitationArtifacts('Answer citeturn1search0.')).toBe(
      'Answer.',
    );
  });

  it('preserves whitespace across citation removal shapes', () => {
    for (const [input, expected] of [
      ['  padded text  ', '  padded text  '],
      ['Answer. citeturn1search0 Next sentence', 'Answer. Next sentence'],
      [
        'The site is indexed. \uE200cite\uE202turn0search0\uE202turn0search1\uE201 Google shows results.',
        'The site is indexed. Google shows results.',
      ],
      ['Answer citeturn1search0 citeturn2search1 next', 'Answer next'],
      ['A citeturn0search0 citeturn1search0 citeturn2search0 B', 'A B'],
      ['X \uE200cite\uE202turn0search0\uE201 citeturn1search0 Y', 'X Y'],
      ['  padded text citeturn0search0  ', '  padded text  '],
      ['Col1\tciteturn0search0\tCol2', 'Col1\tCol2'],
      ['A  citeturn0search0  B', 'A  B'],
    ] as const) {
      expect(stripLlmCitationArtifacts(input)).toBe(expected);
    }
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
