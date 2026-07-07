import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ScrollArea, ScrollBar } from './scroll-area';
import { Separator } from './separator';

const meta = {
  title: 'Foundations/Primitives/ScrollArea',
  component: ScrollArea,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
    children: {
      control: 'text',
      description: 'Content to be scrolled',
    },
  },
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default vertical scrolling
export const Default: Story = {
  render: () => (
    <ScrollArea className="h-72 w-96 rounded-md border">
      <div className="p-4">
        <h4 className="mb-4 text-sm font-medium leading-none">Tags</h4>
        {Array.from({ length: 50 }).map((_, i) => (
          <div key={i}>
            <div className="text-sm">
              v1.2.0-beta.{i} - Released on{' '}
              {new Date(2024, 0, i + 1).toLocaleDateString()}
            </div>
            {i < 49 && <Separator className="my-2" />}
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

// Horizontal scrolling
export const HorizontalScroll: Story = {
  render: () => (
    <div className="w-96 rounded-md border">
      <ScrollArea className="h-24">
        <div className="flex w-max space-x-4 p-4">
          {Array.from({ length: 20 }).map((_, i) => (
            <figure key={i} className="shrink-0">
              <div className="overflow-hidden rounded-md">
                <div className="h-12 w-24 bg-gradient-to-br from-purple-400 to-blue-400 flex items-center justify-center text-white font-semibold">
                  Item {i + 1}
                </div>
              </div>
              <figcaption className="pt-2 text-xs text-muted-foreground">
                Photo {i + 1}
              </figcaption>
            </figure>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  ),
};

// Both scrollbars
export const BothScrollbars: Story = {
  render: () => (
    <ScrollArea className="h-72 w-96 rounded-md border">
      <div className="p-4 w-[600px]">
        <h4 className="mb-4 text-sm font-medium leading-none">
          Wide Content with Many Items
        </h4>
        {Array.from({ length: 30 }).map((_, i) => (
          <div key={i} className="flex items-center space-x-4">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-none">
                Item {i + 1} with a very long description that extends beyond
                the normal viewport width
              </p>
              <p className="text-sm text-muted-foreground">
                email-{i}@example.com • ID:{' '}
                {Math.random().toString(36).substr(2, 9)}
              </p>
            </div>
            {i < 29 && <Separator className="my-2" />}
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};

// With custom height content
export const DifferentContentHeights: Story = {
  render: () => (
    <div className="grid gap-4 grid-cols-2">
      <div>
        <h3 className="mb-2 font-semibold">Short Content</h3>
        <ScrollArea className="h-48 w-full rounded-md border">
          <div className="p-4">
            <p className="text-sm">This is a short content example.</p>
            <p className="text-sm mt-2">It doesn&apos;t need scrolling.</p>
          </div>
        </ScrollArea>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">Long Content</h3>
        <ScrollArea className="h-48 w-full rounded-md border">
          <div className="p-4">
            {Array.from({ length: 20 }).map((_, i) => (
              <p key={i} className="text-sm mb-2">
                Paragraph {i + 1}: Lorem ipsum dolor sit amet, consectetur
                adipiscing elit.
              </p>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  ),
};

// Code block example
export const CodeBlock: Story = {
  render: () => (
    <ScrollArea className="h-72 w-[600px] rounded-md border bg-black p-4">
      <pre className="text-green-400 font-mono text-sm">
        {`import React from 'react';
import { ScrollArea } from '@/components/system';

function MyComponent() {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: \`Item \${i + 1}\`,
    description: \`Description for item \${i + 1}\`,
    price: Math.floor(Math.random() * 1000) / 10,
    category: ['Electronics', 'Books', 'Clothing'][i % 3],
    inStock: Math.random() > 0.3,
    rating: Math.floor(Math.random() * 5) + 1,
    reviews: Math.floor(Math.random() * 1000),
  }));

  return (
    <ScrollArea className="h-96 w-full">
      <div className="space-y-4 p-4">
        {items.map((item) => (
          <div key={item.id} className="border rounded-lg p-4">
            <h3 className="font-semibold">{item.name}</h3>
            <p className="text-sm text-muted-foreground">{item.description}</p>
            <div className="mt-2 flex items-center gap-4">
              <span className="font-bold">\${item.price}</span>
              <span className="text-sm">{item.category}</span>
              <span className={item.inStock ? 'text-green-600' : 'text-red-600'}>
                {item.inStock ? 'In Stock' : 'Out of Stock'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span>{'⭐'.repeat(item.rating)}</span>
              <span className="text-muted-foreground">({item.reviews} reviews)</span>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

export default MyComponent;`}
      </pre>
    </ScrollArea>
  ),
};

// Chat/Messages example
export const ChatMessages: Story = {
  render: () => {
    const messages = [
      {
        id: 1,
        sender: 'Alice',
        message: 'Hey, how are you doing?',
        time: '10:00 AM',
      },
      {
        id: 2,
        sender: 'You',
        message: 'I&apos;m good! Just working on some new features.',
        time: '10:02 AM',
      },
      {
        id: 3,
        sender: 'Alice',
        message: 'That sounds interesting! What are you building?',
        time: '10:03 AM',
      },
      {
        id: 4,
        sender: 'You',
        message: 'A new dashboard with real-time updates.',
        time: '10:05 AM',
      },
      {
        id: 5,
        sender: 'Alice',
        message: 'Nice! Are you using WebSockets?',
        time: '10:06 AM',
      },
      {
        id: 6,
        sender: 'You',
        message: 'Yes, with Socket.io for better browser compatibility.',
        time: '10:08 AM',
      },
      {
        id: 7,
        sender: 'Alice',
        message: 'Smart choice. How&apos;s the performance?',
        time: '10:10 AM',
      },
      {
        id: 8,
        sender: 'You',
        message: 'Pretty good so far. Getting sub-100ms latency.',
        time: '10:12 AM',
      },
      {
        id: 9,
        sender: 'Alice',
        message: 'That&apos;s impressive!',
        time: '10:13 AM',
      },
      {
        id: 10,
        sender: 'You',
        message: 'Thanks! Still optimizing though.',
        time: '10:15 AM',
      },
      {
        id: 11,
        sender: 'Alice',
        message: 'Keep me posted on the progress!',
        time: '10:16 AM',
      },
      { id: 12, sender: 'You', message: 'Will do! 👍', time: '10:17 AM' },
    ];

    return (
      <div className="w-96 border rounded-lg">
        <div className="border-b p-4">
          <h3 className="font-semibold">Chat with Alice</h3>
        </div>
        <ScrollArea className="h-80">
          <div className="p-4 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.sender === 'You' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[70%] rounded-lg px-3 py-2 ${
                    msg.sender === 'You'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}
                >
                  <p className="text-sm">{msg.message}</p>
                  <p className="text-xs mt-1 opacity-70">{msg.time}</p>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  },
};

// Table example
export const DataTable: Story = {
  render: () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      role: ['Admin', 'Editor', 'Viewer'][i % 3],
      status: ['Active', 'Inactive', 'Pending'][i % 3],
      lastLogin: new Date(
        2024,
        0,
        Math.floor(Math.random() * 30) + 1,
      ).toLocaleDateString(),
    }));

    return (
      <div className="w-full max-w-4xl">
        <ScrollArea className="h-96 rounded-md border">
          <div className="w-full">
            <table className="w-full">
              <thead className="sticky top-0 bg-background border-b">
                <tr>
                  <th className="text-left p-4">ID</th>
                  <th className="text-left p-4">Name</th>
                  <th className="text-left p-4">Email</th>
                  <th className="text-left p-4">Role</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Last Login</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="border-b">
                    <td className="p-4">{row.id}</td>
                    <td className="p-4">{row.name}</td>
                    <td className="p-4">{row.email}</td>
                    <td className="p-4">
                      <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-primary/10 text-primary">
                        {row.role}
                      </span>
                    </td>
                    <td className="p-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          row.status === 'Active'
                            ? 'bg-green-100 text-green-700'
                            : row.status === 'Inactive'
                              ? 'bg-gray-100 text-gray-700'
                              : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="p-4">{row.lastLogin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ScrollArea>
      </div>
    );
  },
};

// Playground
export const Playground: Story = {
  args: {
    className: 'h-72 w-96 rounded-md border',
    children: (
      <div className="p-4">
        <h4 className="mb-4 text-sm font-medium leading-none">
          Playground Content
        </h4>
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="py-2">
            Item {i + 1} - You can customize the ScrollArea using the controls
          </div>
        ))}
      </div>
    ),
  },
};
