import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Check } from '@/components/system';
import { Button } from './button';
import { Spinner } from './spinner';

const meta = {
  title: 'Foundations/Primitives/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'destructive',
        'outline',
        'secondary',
        'ghost',
        'link',
      ],
      description: 'The visual style variant of the button',
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon'],
      description: 'The size of the button',
    },
    asChild: {
      control: 'boolean',
      description:
        'Whether to render styles onto a single child element using Radix UI Slot. Not supported with loading.',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the button is disabled',
    },
    loading: {
      control: 'boolean',
      description:
        'Whether the button should render its loading state. Only supported for native button rendering.',
    },
    children: {
      control: 'text',
      description: 'The content of the button',
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const storyVariants = [
  'default',
  'destructive',
  'outline',
  'secondary',
  'ghost',
  'link',
] as const;

const storyVariantLabels: Record<(typeof storyVariants)[number], string> = {
  default: 'Default',
  destructive: 'Destructive',
  outline: 'Outline',
  secondary: 'Secondary',
  ghost: 'Ghost',
  link: 'Link',
};

// Default button
export const Default: Story = {
  args: {
    children: 'Button',
    variant: 'default',
    size: 'default',
  },
};

// All variants
export const Variants: Story = {
  args: {
    size: 'icon',
  },

  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

// All sizes
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Button size="xs">Extra Small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};

// Icon sizes
export const IconSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Button size="icon" variant="default">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
      <Button size="icon" variant="outline">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </Button>
      <Button size="icon" variant="ghost">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Button>
    </div>
  ),
};

// With icons
export const WithIcons: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
        Continue
      </Button>
      <Button variant="outline">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        Schedule
      </Button>
      <Button variant="destructive">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6" />
        </svg>
        Delete
      </Button>
    </div>
  ),
};

// Disabled state
export const Disabled: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button disabled>Default Disabled</Button>
      <Button variant="destructive" disabled>
        Destructive Disabled
      </Button>
      <Button variant="outline" disabled>
        Outline Disabled
      </Button>
      <Button variant="secondary" disabled>
        Secondary Disabled
      </Button>
      <Button variant="ghost" disabled>
        Ghost Disabled
      </Button>
      <Button variant="link" disabled>
        Link Disabled
      </Button>
    </div>
  ),
};

// Loading state
export const Loading: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button loading>Loading...</Button>
      <Button variant="outline" loading>
        Processing
      </Button>
      <Button size="sm" variant="secondary" loading>
        Saving
      </Button>
    </div>
  ),
};

// Spinner in all variants and states
export const SpinnerVariantsAndStates: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button key={`enabled-${variant}`} variant={variant}>
            <Spinner size="sm" />
            {storyVariantLabels[variant]} Enabled
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button key={`disabled-${variant}`} variant={variant} disabled>
            <Spinner size="sm" />
            {storyVariantLabels[variant]} Disabled
          </Button>
        ))}
      </div>
    </div>
  ),
};

// Spinner icon buttons in all variants and states
export const SpinnerIconVariantsAndStates: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button
            key={`icon-enabled-${variant}`}
            variant={variant}
            size="icon"
            aria-label={`${storyVariantLabels[variant]} loading enabled`}
          >
            <Spinner size="sm" />
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button
            key={`icon-disabled-${variant}`}
            variant={variant}
            size="icon"
            disabled
            aria-label={`${storyVariantLabels[variant]} loading disabled`}
          >
            <Spinner size="sm" />
          </Button>
        ))}
      </div>
    </div>
  ),
};

// Real icons (no spinner) in all variants and states
export const CheckIconVariantsAndStates: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button key={`check-enabled-${variant}`} variant={variant}>
            <Check className="size-4" />
            {storyVariantLabels[variant]} Enabled
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        {storyVariants.map((variant) => (
          <Button key={`check-disabled-${variant}`} variant={variant} disabled>
            <Check className="size-4" />
            {storyVariantLabels[variant]} Disabled
          </Button>
        ))}
      </div>
    </div>
  ),
};

// As Child example (button as a link)
export const AsChild: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button asChild>
        <a href="#" onClick={(e) => e.preventDefault()}>
          Link Button
        </a>
      </Button>
      <Button variant="outline" asChild>
        <a href="#" onClick={(e) => e.preventDefault()}>
          Outline Link
        </a>
      </Button>
    </div>
  ),
};

// Full width button
export const FullWidth: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <Button className="w-full">Full Width Button</Button>
      <Button variant="outline" className="w-full mt-2">
        Full Width Outline
      </Button>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    children: 'Click me',
    variant: 'default',
    size: 'default',
    disabled: false,
    asChild: false,
  },
};
