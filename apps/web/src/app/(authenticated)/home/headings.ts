export const HOME_HEADINGS = [
  "Let's cook!",
  'What do you want to crush now?',
  'My GPUs are warm and ready',
  'Tell me what you want, what you really really want',
  "It's time to make a diff",
] as const;

export function getRandomHomeHeading(): (typeof HOME_HEADINGS)[number] {
  return HOME_HEADINGS[Math.floor(Math.random() * HOME_HEADINGS.length)]!;
}
