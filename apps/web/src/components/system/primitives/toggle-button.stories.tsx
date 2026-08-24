import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { List } from '@/components/system';
import { ToggleButton } from './toggle-button';

const meta = {
  title: 'Foundations/Primitives/ToggleButton',
  component: ToggleButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ToggleButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'List view',
  },
};

export const Pressed: Story = {
  args: {
    children: 'List view',
    defaultPressed: true,
  },
};

export const WithIcon: Story = {
  args: {
    'aria-label': 'List view',
    children: <List />,
    size: 'icon',
  },
};
