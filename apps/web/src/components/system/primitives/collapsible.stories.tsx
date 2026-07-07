'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { ChevronDown } from '@/components/system';
import { Button } from './button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';

const meta = {
  title: 'Foundations/Primitives/Collapsible',
  component: Collapsible,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: 'boolean',
      description: 'The controlled open state of the collapsible',
    },
    defaultOpen: {
      control: 'boolean',
      description: 'The default open state when initially rendered',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the collapsible is disabled',
    },
    onOpenChange: {
      action: 'open changed',
      description: 'Callback when the open state changes',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default collapsible (closed)
export const Default: Story = {
  render: () => (
    <Collapsible className="w-[350px] space-y-2">
      <div className="flex items-center justify-between space-x-4 px-4">
        <h4 className="text-sm font-semibold">
          @peduarte starred 3 repositories
        </h4>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-9 p-0">
            <ChevronDown className="h-4 w-4" />
            <span className="sr-only">Toggle</span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <div className="rounded-md border px-4 py-3 font-mono text-sm">
        @radix-ui/primitives
      </div>
      <CollapsibleContent className="space-y-2">
        <div className="rounded-md border px-4 py-3 font-mono text-sm">
          @radix-ui/colors
        </div>
        <div className="rounded-md border px-4 py-3 font-mono text-sm">
          @stitches/react
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};

// Open by default
export const OpenByDefault: Story = {
  render: () => (
    <Collapsible defaultOpen className="w-[350px] space-y-2">
      <div className="flex items-center justify-between space-x-4 px-4">
        <h4 className="text-sm font-semibold">Expanded by default</h4>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-9 p-0">
            <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
            <span className="sr-only">Toggle</span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-2">
        <div className="rounded-md border px-4 py-3 text-sm">
          This content is visible by default
        </div>
        <div className="rounded-md border px-4 py-3 text-sm">
          You can collapse it by clicking the trigger
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};

// Controlled state
export const Controlled: Story = {
  render: function ControlledCollapsible() {
    const [isOpen, setIsOpen] = useState(false);

    return (
      <div className="w-[350px] space-y-4">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(true)}
            disabled={isOpen}
          >
            Open
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(false)}
            disabled={!isOpen}
          >
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(!isOpen)}
          >
            Toggle
          </Button>
        </div>
        <Collapsible
          open={isOpen}
          onOpenChange={setIsOpen}
          className="space-y-2"
        >
          <div className="flex items-center justify-between space-x-4 px-4">
            <h4 className="text-sm font-semibold">Controlled collapsible</h4>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-9 p-0">
                <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
                <span className="sr-only">Toggle</span>
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="space-y-2">
            <div className="rounded-md border px-4 py-3 text-sm">
              This collapsible is controlled by external state
            </div>
            <div className="rounded-md border px-4 py-3 text-sm">
              Use the buttons above or the trigger to control it
            </div>
          </CollapsibleContent>
        </Collapsible>
        <div className="text-sm text-muted-foreground">
          State: {isOpen ? 'Open' : 'Closed'}
        </div>
      </div>
    );
  },
};

// With custom trigger
export const CustomTrigger: Story = {
  render: () => (
    <Collapsible className="w-[400px]">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border p-4 font-medium transition-colors hover:bg-muted/50 data-[state=open]:border-primary">
        <span>Click anywhere on this panel to toggle</span>
        <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-4 space-y-4 px-4">
          <p className="text-sm text-muted-foreground">
            This example shows a custom styled trigger that acts as a full-width
            button. The entire panel is clickable.
          </p>
          <div className="rounded-md bg-muted p-4">
            <p className="text-sm">Additional content goes here...</p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};

// FAQ Example
export const FAQExample: Story = {
  render: () => {
    const faqs = [
      {
        question: 'What is a collapsible component?',
        answer:
          "A collapsible component is a UI element that can expand and collapse to show or hide content. It's useful for organizing information and reducing visual clutter.",
      },
      {
        question: 'When should I use a collapsible?',
        answer:
          "Use collapsibles when you have content that users don't need to see all at once, such as FAQs, detailed descriptions, or advanced options. They help keep interfaces clean and focused.",
      },
      {
        question: 'Can I nest collapsibles?',
        answer:
          'Yes, you can nest collapsibles within each other to create multi-level hierarchical content structures. However, be mindful of usability - too many levels can be confusing.',
      },
    ];

    return (
      <div className="w-[500px] space-y-4">
        <h3 className="text-lg font-semibold">Frequently Asked Questions</h3>
        {faqs.map((faq, index) => (
          <Collapsible key={index} className="space-y-2">
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border p-4 text-left font-medium transition-colors hover:bg-muted/50">
              <span>{faq.question}</span>
              <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200 data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-4 pt-2 text-sm text-muted-foreground">
                {faq.answer}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    );
  },
};

// Settings panel example
export const SettingsPanel: Story = {
  render: () => (
    <div className="w-[400px] space-y-4">
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24" />
            </svg>
            <span className="font-medium">General Settings</span>
          </div>
          <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4 space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <label className="text-sm">Theme</label>
              <select className="rounded border px-2 py-1 text-sm">
                <option>Light</option>
                <option>Dark</option>
                <option>System</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm">Language</label>
              <select className="rounded border px-2 py-1 text-sm">
                <option>English</option>
                <option>Spanish</option>
                <option>French</option>
              </select>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span className="font-medium">Privacy Settings</span>
          </div>
          <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4 space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <label className="text-sm">Profile Visibility</label>
              <select className="rounded border px-2 py-1 text-sm">
                <option>Public</option>
                <option>Private</option>
                <option>Friends Only</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm">Show Online Status</label>
              <input type="checkbox" className="rounded" />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
};

// With animation classes
export const WithAnimation: Story = {
  render: () => (
    <Collapsible className="w-[350px] space-y-2">
      <div className="flex items-center justify-between space-x-4 px-4">
        <h4 className="text-sm font-semibold">Smooth animation example</h4>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            <span className="mr-2">Toggle</span>
            <ChevronDown className="h-4 w-4 transition-transform duration-300 ease-in-out data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="overflow-hidden transition-all data-[state=closed]:animate-slideUp data-[state=open]:animate-slideDown">
        <div className="space-y-2 pt-2">
          <div className="rounded-md border px-4 py-3 text-sm">
            This content slides in and out smoothly
          </div>
          <div className="rounded-md border px-4 py-3 text-sm">
            Using Tailwind animation classes
          </div>
          <div className="rounded-md border px-4 py-3 text-sm">
            For a better user experience
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};

// Disabled state
export const Disabled: Story = {
  render: () => (
    <div className="w-[350px] space-y-4">
      <Collapsible disabled className="space-y-2">
        <div className="flex items-center justify-between space-x-4 px-4">
          <h4 className="text-sm font-semibold text-muted-foreground">
            Disabled collapsible
          </h4>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-9 p-0" disabled>
              <ChevronDown className="h-4 w-4" />
              <span className="sr-only">Toggle</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <div className="rounded-md border px-4 py-3 font-mono text-sm text-muted-foreground">
          This collapsible is disabled
        </div>
        <CollapsibleContent className="space-y-2">
          <div className="rounded-md border px-4 py-3 font-mono text-sm">
            You cannot see this content
          </div>
        </CollapsibleContent>
      </Collapsible>
      <p className="text-sm text-muted-foreground">
        The collapsible above is disabled and cannot be toggled.
      </p>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    defaultOpen: false,
    disabled: false,
    className: 'w-[350px] space-y-2',
    children: (
      <>
        <div className="flex items-center justify-between space-x-4 px-4">
          <h4 className="text-sm font-semibold">Playground Collapsible</h4>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-9 p-0">
              <ChevronDown className="h-4 w-4" />
              <span className="sr-only">Toggle</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-2">
          <div className="rounded-md border px-4 py-3 text-sm">
            Use the controls to experiment with the collapsible component
          </div>
          <div className="rounded-md border px-4 py-3 text-sm">
            You can control the default open state and disabled state
          </div>
        </CollapsibleContent>
      </>
    ),
  },
};
