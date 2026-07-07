import type { Preview } from '@storybook/nextjs-vite';
import { withThemeByClassName } from '@storybook/addon-themes';
import '../src/app/globals.css';
import '../src/stories/previews.css';

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        method: 'alphabetical',
        order: [
          'Foundations',
          ['Primitives'],
          'Patterns',
          ['Layout', 'AI Elements', ['Conversation', 'Composer', 'Feedback']],
          'Surfaces',
          [
            'Task Workspace',
            [
              'Lifecycle',
              'ACP',
              'Sidebar',
              ['Navigation', 'Actions', 'Panels'],
            ],
            'Settings',
          ],
          '*',
        ],
      },
    },
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/task/storybook-preview',
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
      backgrounds: { disable: true },
    },
    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: '', // No class for light mode
        dark: 'dark', // 'dark' class for dark mode
      },
      defaultTheme: 'light',
      parentSelector: 'body',
    }),
  ],
};

export default preview;
