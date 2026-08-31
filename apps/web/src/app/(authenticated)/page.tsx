import { Home } from './home/Home';
import { getRandomHomePromptPlaceholderIndex } from './home/promptPlaceholders';

export default function Page() {
  return (
    <Home initialPlaceholderIndex={getRandomHomePromptPlaceholderIndex()} />
  );
}
