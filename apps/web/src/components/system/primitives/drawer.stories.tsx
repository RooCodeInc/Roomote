import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
import { Button } from './button';

const meta = {
  title: 'Foundations/Primitives/Drawer',
  component: Drawer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default drawer (bottom)
export const Default: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Open Drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Are you absolutely sure?</DrawerTitle>
          <DrawerDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <Button>Submit</Button>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Drawer from different directions
export const Directions: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Drawer>
        <DrawerTrigger asChild>
          <Button variant="outline">Bottom (Default)</Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Bottom Drawer</DrawerTitle>
            <DrawerDescription>
              This drawer slides up from the bottom of the screen.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button>Close</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer direction="top">
        <DrawerTrigger asChild>
          <Button variant="outline">Top</Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Top Drawer</DrawerTitle>
            <DrawerDescription>
              This drawer slides down from the top of the screen.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button>Close</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer direction="left">
        <DrawerTrigger asChild>
          <Button variant="outline">Left</Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Left Drawer</DrawerTitle>
            <DrawerDescription>
              This drawer slides in from the left side of the screen.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button>Close</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer direction="right">
        <DrawerTrigger asChild>
          <Button variant="outline">Right</Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Right Drawer</DrawerTitle>
            <DrawerDescription>
              This drawer slides in from the right side of the screen.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button>Close</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  ),
};

// Drawer with scrollable content
export const ScrollableContent: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>Show Content</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Scrollable Content</DrawerTitle>
          <DrawerDescription>
            This drawer contains scrollable content when it overflows.
          </DrawerDescription>
        </DrawerHeader>
        <div className="overflow-y-auto max-h-75 px-4">
          <div className="space-y-4">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="rounded-lg border p-4">
                <h3 className="font-medium">Item {i + 1}</h3>
                <p className="text-sm text-muted-foreground">
                  This is a sample content item that demonstrates scrollable
                  content within a drawer component.
                </p>
              </div>
            ))}
          </div>
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Drawer with form
export const WithForm: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Add Item</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add New Item</DrawerTitle>
          <DrawerDescription>
            Fill in the details below to add a new item to your list.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 space-y-4">
          <div className="space-y-2">
            <label htmlFor="title" className="text-sm font-medium">
              Title
            </label>
            <input
              id="title"
              type="text"
              className="w-full px-3 py-2 border rounded-md"
              placeholder="Enter title..."
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="description" className="text-sm font-medium">
              Description
            </label>
            <textarea
              id="description"
              className="w-full px-3 py-2 border rounded-md"
              rows={3}
              placeholder="Enter description..."
            />
          </div>
        </div>
        <DrawerFooter>
          <Button>Save</Button>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Controlled drawer
export const Controlled: Story = {
  render: () => {
    const ControlledDrawer = () => {
      const [open, setOpen] = useState(false);

      return (
        <>
          <div className="space-y-4">
            <div className="flex gap-4">
              <Button onClick={() => setOpen(true)}>Open Drawer</Button>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close Drawer
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              Drawer is:{' '}
              <span className="font-medium">{open ? 'Open' : 'Closed'}</span>
            </div>
          </div>
          <Drawer open={open} onOpenChange={setOpen}>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Controlled Drawer</DrawerTitle>
                <DrawerDescription>
                  This drawer is controlled by React state. You can open and
                  close it programmatically.
                </DrawerDescription>
              </DrawerHeader>
              <div className="px-4 py-6">
                <Button onClick={() => setOpen(false)}>
                  Close from inside
                </Button>
              </div>
              <DrawerFooter>
                <DrawerClose asChild>
                  <Button variant="outline">Close</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </>
      );
    };

    return <ControlledDrawer />;
  },
};

// Side navigation drawer
export const SideNavigation: Story = {
  render: () => (
    <Drawer direction="left">
      <DrawerTrigger asChild>
        <Button variant="ghost" size="icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Navigation</DrawerTitle>
        </DrawerHeader>
        <nav className="flex flex-col gap-2 p-4">
          <a
            href="#"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
            onClick={(e) => e.preventDefault()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Home
          </a>
          <a
            href="#"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
            onClick={(e) => e.preventDefault()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </a>
          <a
            href="#"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
            onClick={(e) => e.preventDefault()}
          >
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
            Settings
          </a>
          <a
            href="#"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
            onClick={(e) => e.preventDefault()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Logout
          </a>
        </nav>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Confirmation drawer
export const Confirmation: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="destructive">Delete Account</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>⚠️ Delete Account</DrawerTitle>
          <DrawerDescription>
            This action is permanent and cannot be undone.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 py-6 space-y-4">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm">
              You are about to permanently delete your account. This will:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              <li>• Remove all your personal data</li>
              <li>• Cancel any active subscriptions</li>
              <li>• Delete all your saved preferences</li>
              <li>• Remove access to all your content</li>
            </ul>
          </div>
          <div className="space-y-2">
            <label htmlFor="confirm" className="text-sm font-medium">
              Type DELETE to confirm
            </label>
            <input
              id="confirm"
              type="text"
              className="w-full px-3 py-2 border rounded-md"
              placeholder="Type DELETE to confirm"
            />
          </div>
        </div>
        <DrawerFooter>
          <Button variant="destructive">Delete Account</Button>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Mobile-optimized drawer
export const MobileOptimized: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>Mobile Actions</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader className="text-left">
          <DrawerTitle>Share</DrawerTitle>
          <DrawerDescription>
            Choose how you want to share this content
          </DrawerDescription>
        </DrawerHeader>
        <div className="grid grid-cols-3 gap-4 p-4">
          {[
            { icon: '📧', label: 'Email' },
            { icon: '💬', label: 'Message' },
            { icon: '🔗', label: 'Copy Link' },
            { icon: '📱', label: 'WhatsApp' },
            { icon: '🐦', label: 'Twitter' },
            { icon: '📘', label: 'Facebook' },
          ].map((item) => (
            <button
              key={item.label}
              className="flex flex-col items-center gap-2 rounded-lg p-4 hover:bg-accent"
              onClick={(e) => e.preventDefault()}
            >
              <span className="text-2xl">{item.icon}</span>
              <span className="text-xs">{item.label}</span>
            </button>
          ))}
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

// Nested content drawer
export const NestedContent: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">View Details</Button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[80vh]">
        <DrawerHeader>
          <DrawerTitle>Product Details</DrawerTitle>
          <DrawerDescription>
            Premium wireless headphones with active noise cancellation
          </DrawerDescription>
        </DrawerHeader>
        <div className="overflow-y-auto px-4">
          <div className="space-y-6 py-4">
            <div>
              <h3 className="font-medium mb-2">Features</h3>
              <ul className="space-y-1 text-sm text-muted-foreground">
                <li>• Active Noise Cancellation</li>
                <li>• 30-hour battery life</li>
                <li>• Premium sound quality</li>
                <li>• Comfortable over-ear design</li>
              </ul>
            </div>
            <div>
              <h3 className="font-medium mb-2">Specifications</h3>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Weight:</dt>
                  <dd>250g</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Battery:</dt>
                  <dd>30 hours</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Bluetooth:</dt>
                  <dd>5.0</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Charging:</dt>
                  <dd>USB-C</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3 className="font-medium mb-2">Reviews</h3>
              <div className="space-y-3">
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">John D.</span>
                    <span className="text-xs text-muted-foreground">★★★★★</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Excellent sound quality and comfort. Worth every penny!
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">Sarah M.</span>
                    <span className="text-xs text-muted-foreground">★★★★☆</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Great headphones, but wish they folded for travel.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <DrawerFooter>
          <Button>Add to Cart</Button>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};
