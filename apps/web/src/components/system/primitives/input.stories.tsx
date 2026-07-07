import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Input } from './input';
import { Label } from './label';
import {
  Search,
  Mail,
  Lock,
  User,
  Calendar,
  DollarSign,
  Eye,
  EyeOff,
} from '@/components/system';
import { useState } from 'react';

const meta = {
  title: 'Foundations/Primitives/Input',
  component: Input,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'select',
      options: [
        'text',
        'email',
        'password',
        'number',
        'tel',
        'url',
        'search',
        'date',
        'time',
        'datetime-local',
      ],
      description: 'The type of input',
    },
    placeholder: {
      control: 'text',
      description: 'The placeholder text',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the input is disabled',
    },
    required: {
      control: 'boolean',
      description: 'Whether the input is required',
    },
    readOnly: {
      control: 'boolean',
      description: 'Whether the input is read-only',
    },
    value: {
      control: 'text',
      description: 'The value of the input',
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default input
export const Default: Story = {
  args: {
    type: 'text',
    placeholder: 'Enter text...',
  },
};

// Different input types
export const InputTypes: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="text">Text</Label>
        <Input id="text" type="text" placeholder="Enter text..." />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="name@example.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" placeholder="Enter password..." />
      </div>
      <div className="space-y-2">
        <Label htmlFor="number">Number</Label>
        <Input id="number" type="number" placeholder="0" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="tel">Phone</Label>
        <Input id="tel" type="tel" placeholder="+1 (555) 000-0000" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="url">URL</Label>
        <Input id="url" type="url" placeholder="https://example.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="search">Search</Label>
        <Input id="search" type="search" placeholder="Search..." />
      </div>
      <div className="space-y-2">
        <Label htmlFor="date">Date</Label>
        <Input id="date" type="date" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="time">Time</Label>
        <Input id="time" type="time" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="datetime">Date & Time</Label>
        <Input id="datetime" type="datetime-local" />
      </div>
    </div>
  ),
};

// Different states
export const States: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label>Default</Label>
        <Input type="text" placeholder="Default input" />
      </div>
      <div className="space-y-2">
        <Label>Focused (click to focus)</Label>
        <Input type="text" placeholder="Click to focus" />
      </div>
      <div className="space-y-2">
        <Label>Disabled</Label>
        <Input type="text" placeholder="Disabled input" disabled />
      </div>
      <div className="space-y-2">
        <Label>Read Only</Label>
        <Input type="text" value="Read only value" readOnly />
      </div>
      <div className="space-y-2">
        <Label>Required</Label>
        <Input type="text" placeholder="Required field" required />
      </div>
      <div className="space-y-2">
        <Label>With Value</Label>
        <Input type="text" defaultValue="Input with value" />
      </div>
    </div>
  ),
};

// Error states
export const ErrorStates: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="error1">Invalid Input</Label>
        <Input
          id="error1"
          type="email"
          placeholder="Enter email..."
          defaultValue="invalid-email"
          aria-invalid="true"
        />
        <p className="text-sm text-destructive">
          Please enter a valid email address
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="error2">Required Field</Label>
        <Input
          id="error2"
          type="text"
          placeholder="This field is required"
          aria-invalid="true"
        />
        <p className="text-sm text-destructive">This field is required</p>
      </div>
    </div>
  ),
};

// With icons
export const WithIcons: Story = {
  render: () => {
    const [showPassword, setShowPassword] = useState(false);

    return (
      <div className="space-y-4 w-full max-w-sm">
        <div className="space-y-2">
          <Label>Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input type="search" placeholder="Search..." className="pl-9" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              type="email"
              placeholder="name@example.com"
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Username</Label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input type="text" placeholder="johndoe" className="pl-9" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Password with toggle</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter password"
              className="pl-9 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Amount</Label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input type="number" placeholder="0.00" className="pl-9" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Date</Label>
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input type="date" className="pl-9" />
          </div>
        </div>
      </div>
    );
  },
};

// File input
export const FileInput: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="file1">Upload File</Label>
        <Input id="file1" type="file" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="file2">Upload Image</Label>
        <Input id="file2" type="file" accept="image/*" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="file3">Upload Multiple Files</Label>
        <Input id="file3" type="file" multiple />
      </div>
    </div>
  ),
};

// With helper text
export const WithHelperText: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input id="username" type="text" placeholder="johndoe" />
        <p className="text-sm text-muted-foreground">
          This will be your public display name.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="password-help">Password</Label>
        <Input
          id="password-help"
          type="password"
          placeholder="Enter password"
        />
        <p className="text-sm text-muted-foreground">
          Must be at least 8 characters with one uppercase letter.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="website">Website</Label>
        <Input id="website" type="url" placeholder="https://example.com" />
        <p className="text-sm text-muted-foreground">
          Include the full URL with http:// or https://
        </p>
      </div>
    </div>
  ),
};

// Form example
export const FormExample: Story = {
  render: () => (
    <form className="space-y-4 w-full max-w-md p-6 border rounded-lg">
      <h3 className="text-lg font-semibold">Contact Information</h3>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="first-name">First Name</Label>
          <Input id="first-name" type="text" placeholder="John" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="last-name">Last Name</Label>
          <Input id="last-name" type="text" placeholder="Doe" required />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="form-email">Email</Label>
        <Input
          id="form-email"
          type="email"
          placeholder="john.doe@example.com"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone Number</Label>
        <Input id="phone" type="tel" placeholder="+1 (555) 000-0000" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="message">Message</Label>
        <textarea
          id="message"
          className="flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          placeholder="Enter your message..."
          rows={4}
        />
      </div>

      <button
        type="submit"
        className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        onClick={(e) => e.preventDefault()}
      >
        Submit
      </button>
    </form>
  ),
};

// Sizes (custom through className)
export const Sizes: Story = {
  render: () => (
    <div className="space-y-4 w-full max-w-sm">
      <div className="space-y-2">
        <Label>Small (custom h-8)</Label>
        <Input type="text" placeholder="Small input" className="h-8 text-xs" />
      </div>
      <div className="space-y-2">
        <Label>Default</Label>
        <Input type="text" placeholder="Default input" />
      </div>
      <div className="space-y-2">
        <Label>Large (custom h-11)</Label>
        <Input
          type="text"
          placeholder="Large input"
          className="h-11 text-base"
        />
      </div>
      <div className="space-y-2">
        <Label>Extra Large (custom h-12)</Label>
        <Input
          type="text"
          placeholder="Extra large input"
          className="h-12 text-lg"
        />
      </div>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    type: 'text',
    placeholder: 'Enter text...',
    disabled: false,
    required: false,
    readOnly: false,
  },
};
