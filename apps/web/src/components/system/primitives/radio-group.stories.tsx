import React from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { Label } from './label';

const meta = {
  title: 'Foundations/Primitives/RadioGroup',
  component: RadioGroup,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultValue: {
      control: 'text',
      description: 'The default selected value',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the radio group is disabled',
    },
    orientation: {
      control: 'select',
      options: ['vertical', 'horizontal'],
      description: 'The orientation of the radio group',
    },
  },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default radio group
export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="option-1">
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-1" id="option-1" />
        <Label htmlFor="option-1">Option 1</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-2" id="option-2" />
        <Label htmlFor="option-2">Option 2</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-3" id="option-3" />
        <Label htmlFor="option-3">Option 3</Label>
      </div>
    </RadioGroup>
  ),
};

// Vertical orientation (default)
export const VerticalOrientation: Story = {
  render: () => (
    <RadioGroup defaultValue="comfortable" className="space-y-2">
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="default" id="r1" />
        <Label htmlFor="r1">Default</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="comfortable" id="r2" />
        <Label htmlFor="r2">Comfortable</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="compact" id="r3" />
        <Label htmlFor="r3">Compact</Label>
      </div>
    </RadioGroup>
  ),
};

// Horizontal orientation
export const HorizontalOrientation: Story = {
  render: () => (
    <RadioGroup defaultValue="card" className="flex flex-row gap-6">
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="card" id="card" />
        <Label htmlFor="card">Card</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="paypal" id="paypal" />
        <Label htmlFor="paypal">PayPal</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="apple" id="apple" />
        <Label htmlFor="apple">Apple Pay</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="google" id="google" />
        <Label htmlFor="google">Google Pay</Label>
      </div>
    </RadioGroup>
  ),
};

// With descriptions
export const WithDescriptions: Story = {
  render: () => (
    <RadioGroup defaultValue="startup" className="space-y-4">
      <div className="flex items-start space-x-3">
        <RadioGroupItem value="startup" id="startup" className="mt-1" />
        <div className="grid gap-1.5">
          <Label htmlFor="startup">Startup</Label>
          <p className="text-sm text-muted-foreground">
            Perfect for small teams and early-stage companies
          </p>
        </div>
      </div>
      <div className="flex items-start space-x-3">
        <RadioGroupItem value="business" id="business" className="mt-1" />
        <div className="grid gap-1.5">
          <Label htmlFor="business">Business</Label>
          <p className="text-sm text-muted-foreground">
            For growing teams that need advanced features
          </p>
        </div>
      </div>
      <div className="flex items-start space-x-3">
        <RadioGroupItem value="enterprise" id="enterprise" className="mt-1" />
        <div className="grid gap-1.5">
          <Label htmlFor="enterprise">Enterprise</Label>
          <p className="text-sm text-muted-foreground">
            Complete solution with priority support and custom features
          </p>
        </div>
      </div>
    </RadioGroup>
  ),
};

// Disabled states
export const DisabledStates: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-muted-foreground mb-3">
          All options disabled
        </p>
        <RadioGroup defaultValue="option-1" disabled>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="option-1" id="dis-1" />
            <Label htmlFor="dis-1">Option 1</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="option-2" id="dis-2" />
            <Label htmlFor="dis-2">Option 2</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="option-3" id="dis-3" />
            <Label htmlFor="dis-3">Option 3</Label>
          </div>
        </RadioGroup>
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-3">
          Individual options disabled
        </p>
        <RadioGroup defaultValue="active">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="active" id="active" />
            <Label htmlFor="active">Active Option</Label>
          </div>
          <div className="flex items-center space-x-2 opacity-50">
            <RadioGroupItem value="disabled-1" id="disabled-1" disabled />
            <Label htmlFor="disabled-1">Disabled Option</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="another" id="another" />
            <Label htmlFor="another">Another Active Option</Label>
          </div>
          <div className="flex items-center space-x-2 opacity-50">
            <RadioGroupItem value="disabled-2" id="disabled-2" disabled />
            <Label htmlFor="disabled-2">Another Disabled</Label>
          </div>
        </RadioGroup>
      </div>
    </div>
  ),
};

// Many options
export const ManyOptions: Story = {
  render: () => (
    <RadioGroup defaultValue="option-3" className="space-y-2">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center space-x-2">
          <RadioGroupItem value={`option-${i + 1}`} id={`many-${i + 1}`} />
          <Label htmlFor={`many-${i + 1}`}>Option {i + 1}</Label>
        </div>
      ))}
    </RadioGroup>
  ),
};

// Controlled state example
export const ControlledState: Story = {
  render: () => {
    const [value, setValue] = React.useState('email');

    return (
      <div className="space-y-4">
        <RadioGroup value={value} onValueChange={setValue}>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="email" id="email" />
            <Label htmlFor="email">Email</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="sms" id="sms" />
            <Label htmlFor="sms">SMS</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="push" id="push" />
            <Label htmlFor="push">Push Notification</Label>
          </div>
        </RadioGroup>

        <div className="p-4 bg-gray-100 rounded-md">
          <p className="text-sm">
            Selected value: <span className="font-medium">{value}</span>
          </p>
        </div>

        <div className="flex gap-2">
          <button
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => setValue('email')}
          >
            Set to Email
          </button>
          <button
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => setValue('sms')}
          >
            Set to SMS
          </button>
          <button
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => setValue('push')}
          >
            Set to Push
          </button>
        </div>
      </div>
    );
  },
};

// Card style options
export const CardStyle: Story = {
  render: () => (
    <RadioGroup defaultValue="standard" className="grid gap-4">
      <div className="flex items-center space-x-2 border rounded-lg p-4 cursor-pointer hover:bg-gray-50">
        <RadioGroupItem value="standard" id="standard" />
        <div className="flex-1">
          <Label htmlFor="standard" className="cursor-pointer">
            Standard Shipping
          </Label>
          <p className="text-sm text-muted-foreground mt-1">
            5-7 business days • Free
          </p>
        </div>
      </div>
      <div className="flex items-center space-x-2 border rounded-lg p-4 cursor-pointer hover:bg-gray-50">
        <RadioGroupItem value="express" id="express" />
        <div className="flex-1">
          <Label htmlFor="express" className="cursor-pointer">
            Express Shipping
          </Label>
          <p className="text-sm text-muted-foreground mt-1">
            2-3 business days • $9.99
          </p>
        </div>
      </div>
      <div className="flex items-center space-x-2 border rounded-lg p-4 cursor-pointer hover:bg-gray-50">
        <RadioGroupItem value="overnight" id="overnight" />
        <div className="flex-1">
          <Label htmlFor="overnight" className="cursor-pointer">
            Overnight Shipping
          </Label>
          <p className="text-sm text-muted-foreground mt-1">
            Next business day • $29.99
          </p>
        </div>
      </div>
    </RadioGroup>
  ),
};

// Icon options
export const WithIcons: Story = {
  render: () => (
    <RadioGroup defaultValue="light" className="flex gap-4">
      <div className="flex flex-col items-center space-y-2">
        <div className="flex items-center justify-center w-20 h-20 border rounded-lg hover:bg-gray-50">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="light" id="light" />
          <Label htmlFor="light">Light</Label>
        </div>
      </div>

      <div className="flex flex-col items-center space-y-2">
        <div className="flex items-center justify-center w-20 h-20 border rounded-lg hover:bg-gray-50">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="dark" id="dark" />
          <Label htmlFor="dark">Dark</Label>
        </div>
      </div>

      <div className="flex flex-col items-center space-y-2">
        <div className="flex items-center justify-center w-20 h-20 border rounded-lg hover:bg-gray-50">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="9" x2="15" y2="15" />
            <line x1="15" y1="9" x2="9" y2="15" />
          </svg>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="system" id="system" />
          <Label htmlFor="system">System</Label>
        </div>
      </div>
    </RadioGroup>
  ),
};

// Custom colors
export const CustomColors: Story = {
  render: () => (
    <div className="space-y-6">
      <RadioGroup defaultValue="blue" className="flex gap-4">
        <div className="flex items-center space-x-2">
          <RadioGroupItem
            value="blue"
            id="blue"
            className="border-blue-500 text-blue-500"
          />
          <Label htmlFor="blue">Blue</Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem
            value="green"
            id="green"
            className="border-green-500 text-green-500"
          />
          <Label htmlFor="green">Green</Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem
            value="red"
            id="red"
            className="border-red-500 text-red-500"
          />
          <Label htmlFor="red">Red</Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem
            value="purple"
            id="purple"
            className="border-purple-500 text-purple-500"
          />
          <Label htmlFor="purple">Purple</Label>
        </div>
      </RadioGroup>
    </div>
  ),
};

// Size variations
export const SizeVariations: Story = {
  render: () => (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground mb-3">Small size</p>
        <RadioGroup defaultValue="small-1" className="flex gap-4">
          <div className="flex items-center space-x-1">
            <RadioGroupItem value="small-1" id="small-1" className="w-3 h-3" />
            <Label htmlFor="small-1" className="text-sm">
              Small 1
            </Label>
          </div>
          <div className="flex items-center space-x-1">
            <RadioGroupItem value="small-2" id="small-2" className="w-3 h-3" />
            <Label htmlFor="small-2" className="text-sm">
              Small 2
            </Label>
          </div>
        </RadioGroup>
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-3">Default size</p>
        <RadioGroup defaultValue="default-1" className="flex gap-4">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="default-1" id="default-1" />
            <Label htmlFor="default-1">Default 1</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="default-2" id="default-2" />
            <Label htmlFor="default-2">Default 2</Label>
          </div>
        </RadioGroup>
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-3">Large size</p>
        <RadioGroup defaultValue="large-1" className="flex gap-4">
          <div className="flex items-center space-x-3">
            <RadioGroupItem value="large-1" id="large-1" className="w-6 h-6" />
            <Label htmlFor="large-1" className="text-lg">
              Large 1
            </Label>
          </div>
          <div className="flex items-center space-x-3">
            <RadioGroupItem value="large-2" id="large-2" className="w-6 h-6" />
            <Label htmlFor="large-2" className="text-lg">
              Large 2
            </Label>
          </div>
        </RadioGroup>
      </div>
    </div>
  ),
};

// Form example
export const FormExample: Story = {
  render: () => {
    const [notifications, setNotifications] = React.useState('all');
    const [privacy, setPrivacy] = React.useState('friends');

    return (
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-3">
          <h3 className="text-lg font-medium">Notification Preferences</h3>
          <RadioGroup value={notifications} onValueChange={setNotifications}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="all" id="all" />
              <Label htmlFor="all">All notifications</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="mentions" id="mentions" />
              <Label htmlFor="mentions">Mentions only</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="none" id="none" />
              <Label htmlFor="none">No notifications</Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-3">
          <h3 className="text-lg font-medium">Privacy Settings</h3>
          <RadioGroup value={privacy} onValueChange={setPrivacy}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="public" id="public" />
              <Label htmlFor="public">Public</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="friends" id="friends" />
              <Label htmlFor="friends">Friends only</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="private" id="private" />
              <Label htmlFor="private">Private</Label>
            </div>
          </RadioGroup>
        </div>

        <div className="pt-4 border-t">
          <button className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
            Save Preferences
          </button>
        </div>
      </div>
    );
  },
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    defaultValue: 'option-1',
    disabled: false,
  },
  render: (args) => (
    <RadioGroup {...args}>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-1" id="play-1" />
        <Label htmlFor="play-1">First Option</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-2" id="play-2" />
        <Label htmlFor="play-2">Second Option</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="option-3" id="play-3" />
        <Label htmlFor="play-3">Third Option</Label>
      </div>
    </RadioGroup>
  ),
};
