import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Label } from './label';
import { Input } from './input';
import { Checkbox } from './checkbox';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { Switch } from './switch';
import { Textarea } from './textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

const meta = {
  title: 'Foundations/Primitives/Label',
  component: Label,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    children: {
      control: 'text',
      description: 'The content of the label',
    },
    htmlFor: {
      control: 'text',
      description: 'The ID of the form element this label is for',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default label
export const Default: Story = {
  args: {
    children: 'Label text',
  },
};

// Basic labels
export const BasicLabels: Story = {
  render: () => (
    <div className="space-y-4">
      <Label>Default Label</Label>
      <Label className="text-xs">Extra Small Label</Label>
      <Label className="text-sm">Small Label</Label>
      <Label className="text-base">Base Label</Label>
      <Label className="text-lg">Large Label</Label>
      <Label className="text-xl">Extra Large Label</Label>
    </div>
  ),
};

// With required indicator
export const RequiredIndicator: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="required1">
          Username <span className="text-destructive">*</span>
        </Label>
        <Input
          id="required1"
          type="text"
          placeholder="Enter username"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="required2">
          Email Address <span className="text-destructive">*</span>
        </Label>
        <Input
          id="required2"
          type="email"
          placeholder="name@example.com"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="optional">
          Phone Number{' '}
          <span className="text-muted-foreground text-xs">(optional)</span>
        </Label>
        <Input id="optional" type="tel" placeholder="+1 (555) 000-0000" />
      </div>

      <p className="text-sm text-muted-foreground">
        <span className="text-destructive">*</span> Required fields
      </p>
    </div>
  ),
};

// With different form controls
export const WithFormControls: Story = {
  render: () => (
    <div className="space-y-6 w-full max-w-md">
      {/* With Input */}
      <div className="space-y-2">
        <Label htmlFor="input-example">Text Input</Label>
        <Input id="input-example" type="text" placeholder="Enter text..." />
      </div>

      {/* With Textarea */}
      <div className="space-y-2">
        <Label htmlFor="textarea-example">Message</Label>
        <Textarea
          id="textarea-example"
          placeholder="Enter your message..."
          rows={3}
        />
      </div>

      {/* With Select */}
      <div className="space-y-2">
        <Label htmlFor="select-example">Country</Label>
        <Select>
          <SelectTrigger id="select-example">
            <SelectValue placeholder="Select a country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">United States</SelectItem>
            <SelectItem value="uk">United Kingdom</SelectItem>
            <SelectItem value="ca">Canada</SelectItem>
            <SelectItem value="au">Australia</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* With Checkbox */}
      <div className="flex items-center space-x-2">
        <Checkbox id="checkbox-example" />
        <Label
          htmlFor="checkbox-example"
          className="cursor-pointer font-normal"
        >
          I agree to the terms and conditions
        </Label>
      </div>

      {/* With Switch */}
      <div className="flex items-center justify-between">
        <Label htmlFor="switch-example">Enable notifications</Label>
        <Switch id="switch-example" />
      </div>

      {/* With Radio Group */}
      <div className="space-y-2">
        <Label>Subscription Plan</Label>
        <RadioGroup defaultValue="basic">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="basic" id="basic" />
            <Label htmlFor="basic" className="cursor-pointer font-normal">
              Basic ($9/month)
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="pro" id="pro" />
            <Label htmlFor="pro" className="cursor-pointer font-normal">
              Pro ($19/month)
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="enterprise" id="enterprise" />
            <Label htmlFor="enterprise" className="cursor-pointer font-normal">
              Enterprise ($49/month)
            </Label>
          </div>
        </RadioGroup>
      </div>
    </div>
  ),
};

// With helper text
export const WithHelperText: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="username-help">Username</Label>
        <Input id="username-help" type="text" placeholder="johndoe" />
        <p className="text-sm text-muted-foreground">
          This will be your public display name.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email-help">
          Email <span className="text-destructive">*</span>
        </Label>
        <Input
          id="email-help"
          type="email"
          placeholder="name@example.com"
          required
        />
        <p className="text-sm text-muted-foreground">
          We&apos;ll never share your email with anyone else.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="bio-help">Bio</Label>
        <Textarea
          id="bio-help"
          placeholder="Tell us about yourself..."
          rows={3}
        />
        <p className="text-sm text-muted-foreground">
          Maximum 500 characters. <span className="text-xs">0/500</span>
        </p>
      </div>
    </div>
  ),
};

// Disabled state
export const DisabledState: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2 opacity-50">
        <Label htmlFor="disabled-input">Disabled Field</Label>
        <Input
          id="disabled-input"
          type="text"
          placeholder="Cannot edit"
          disabled
        />
      </div>

      <div className="flex items-center space-x-2 opacity-50">
        <Checkbox id="disabled-checkbox" disabled />
        <Label htmlFor="disabled-checkbox" className="cursor-not-allowed">
          Disabled checkbox option
        </Label>
      </div>

      <div className="flex items-center justify-between opacity-50">
        <Label htmlFor="disabled-switch">Disabled toggle</Label>
        <Switch id="disabled-switch" disabled />
      </div>
    </div>
  ),
};

// Styled labels
export const StyledLabels: Story = {
  render: () => (
    <div className="space-y-4">
      <Label className="text-primary">Primary Color Label</Label>
      <Label className="text-destructive">Error/Destructive Label</Label>
      <Label className="text-muted-foreground">Muted Label</Label>
      <Label className="font-bold">Bold Label</Label>
      <Label className="italic">Italic Label</Label>
      <Label className="underline">Underlined Label</Label>
      <Label className="uppercase text-xs tracking-wider">
        Uppercase Label
      </Label>
    </div>
  ),
};

// Complex form example
export const ComplexFormExample: Story = {
  render: () => (
    <form className="space-y-6 w-full max-w-lg p-6 border rounded-lg">
      <div>
        <h3 className="text-lg font-semibold mb-4">Account Information</h3>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="space-y-2">
            <Label htmlFor="first-name">
              First Name <span className="text-destructive">*</span>
            </Label>
            <Input id="first-name" type="text" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="last-name">
              Last Name <span className="text-destructive">*</span>
            </Label>
            <Input id="last-name" type="text" required />
          </div>
        </div>

        <div className="space-y-2 mb-4">
          <Label htmlFor="email">
            Email Address <span className="text-destructive">*</span>
          </Label>
          <Input id="email" type="email" required />
          <p className="text-sm text-muted-foreground">
            We&apos;ll use this for account recovery and notifications.
          </p>
        </div>

        <div className="space-y-2 mb-4">
          <Label htmlFor="password">
            Password <span className="text-destructive">*</span>
          </Label>
          <Input id="password" type="password" required />
          <p className="text-sm text-muted-foreground">
            Minimum 8 characters with at least one uppercase letter and number.
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Preferences</h3>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="marketing">Receive marketing emails</Label>
            <Switch id="marketing" />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="analytics">Share usage analytics</Label>
            <Switch id="analytics" defaultChecked />
          </div>

          <div className="space-y-2">
            <Label>Notification Frequency</Label>
            <RadioGroup defaultValue="weekly">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="daily" id="daily" />
                <Label htmlFor="daily" className="cursor-pointer font-normal">
                  Daily digest
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="weekly" id="weekly" />
                <Label htmlFor="weekly" className="cursor-pointer font-normal">
                  Weekly summary
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="never" id="never" />
                <Label htmlFor="never" className="cursor-pointer font-normal">
                  Never
                </Label>
              </div>
            </RadioGroup>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Checkbox id="terms" required />
          <Label htmlFor="terms" className="cursor-pointer font-normal">
            I agree to the{' '}
            <a
              href="#"
              className="underline"
              onClick={(e) => e.preventDefault()}
            >
              terms of service
            </a>{' '}
            and{' '}
            <a
              href="#"
              className="underline"
              onClick={(e) => e.preventDefault()}
            >
              privacy policy
            </a>
            <span className="text-destructive ml-1">*</span>
          </Label>
        </div>

        <p className="text-sm text-muted-foreground">
          <span className="text-destructive">*</span> Required fields
        </p>

        <button
          type="submit"
          className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          onClick={(e) => e.preventDefault()}
        >
          Create Account
        </button>
      </div>
    </form>
  ),
};

// Inline labels
export const InlineLabels: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-md">
      <div className="flex items-center gap-4">
        <Label htmlFor="inline1" className="min-w-[100px]">
          Name:
        </Label>
        <Input id="inline1" type="text" placeholder="Enter name" />
      </div>

      <div className="flex items-center gap-4">
        <Label htmlFor="inline2" className="min-w-[100px]">
          Email:
        </Label>
        <Input id="inline2" type="email" placeholder="name@example.com" />
      </div>

      <div className="flex items-center gap-4">
        <Label htmlFor="inline3" className="min-w-[100px]">
          Phone:
        </Label>
        <Input id="inline3" type="tel" placeholder="+1 (555) 000-0000" />
      </div>

      <div className="flex items-center gap-4">
        <Label htmlFor="inline4" className="min-w-[100px]">
          Country:
        </Label>
        <Select>
          <SelectTrigger id="inline4">
            <SelectValue placeholder="Select country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">United States</SelectItem>
            <SelectItem value="uk">United Kingdom</SelectItem>
            <SelectItem value="ca">Canada</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    children: 'Edit this label text',
    htmlFor: 'playground-input',
  },
  render: (args) => (
    <div className="space-y-2">
      <Label {...args} />
      <Input id="playground-input" type="text" placeholder="Associated input" />
    </div>
  ),
};
