import { getRandomHomeHeading, HOME_HEADINGS } from './headings';

describe('getRandomHomeHeading', () => {
  it('selects from exactly the configured homepage headings', () => {
    expect(HOME_HEADINGS).toEqual([
      "Let's cook!",
      'What do you want to crush now?',
      'My GPUs are warm and ready',
      'Tell me what you want, what you really really want',
      "It's time to make a diff",
    ]);
  });

  it.each([
    [0, "Let's cook!"],
    [0.4, 'My GPUs are warm and ready'],
    [0.999, "It's time to make a diff"],
  ])('maps a random value of %s to %s', (randomValue, expected) => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(randomValue);

    expect(getRandomHomeHeading()).toBe(expected);
  });
});
