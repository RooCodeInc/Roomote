import { Home } from './home/Home';
import { getRandomHomeHeading } from './home/headings';
import { getRandomHomePromptPlaceholderIndex } from './home/promptPlaceholders';

export default function Page() {
  return (
    <Home
      initialHeading={getRandomHomeHeading()}
      initialPlaceholderIndex={getRandomHomePromptPlaceholderIndex()}
    />
  );
}
