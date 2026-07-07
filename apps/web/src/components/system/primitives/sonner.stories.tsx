'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { toast } from 'sonner';
import { Toaster } from './sonner';
import { Button } from './button';

const meta: Meta<typeof Toaster> = {
  title: 'Foundations/Primitives/Sonner',
  component: Toaster,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    theme: {
      control: 'select',
      options: ['light', 'dark', 'system'],
      description: 'The theme of the toaster',
    },
    position: {
      control: 'select',
      options: [
        'top-left',
        'top-center',
        'top-right',
        'bottom-left',
        'bottom-center',
        'bottom-right',
      ],
      description: 'Position of the toast notifications',
    },
    richColors: {
      control: 'boolean',
      description: 'Use rich colors for different toast types',
    },
    expand: {
      control: 'boolean',
      description: 'Expand toasts by default',
    },
    duration: {
      control: 'number',
      description: 'Duration in milliseconds',
    },
    closeButton: {
      control: 'boolean',
      description: 'Show close button on toasts',
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-100 p-8">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Default toaster with basic notifications
export const Default: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex gap-4">
        <Button onClick={() => toast('This is a default toast notification')}>
          Show Toast
        </Button>
      </div>
    </>
  ),
};

// Different toast types
export const Types: Story = {
  render: () => (
    <>
      <Toaster richColors />
      <div className="flex flex-wrap gap-4">
        <Button onClick={() => toast('Default notification')}>Default</Button>
        <Button
          variant="outline"
          onClick={() => toast.success('Success! Your action was completed.')}
        >
          Success
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.error('Error! Something went wrong.')}
        >
          Error
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.warning('Warning! Please review your input.')}
        >
          Warning
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.info("Info: Here's some useful information.")}
        >
          Info
        </Button>
      </div>
    </>
  ),
};

// Different positions
export const Positions: Story = {
  render: () => {
    const positions = [
      'top-left',
      'top-center',
      'top-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ] as const;

    return (
      <>
        <Toaster position="top-center" />
        <div className="grid grid-cols-3 gap-4 max-w-2xl mx-auto">
          {positions.map((position) => (
            <Button
              key={position}
              variant="outline"
              onClick={() => {
                // Clear existing toasts
                toast.dismiss();
                // Show new toast at position
                const id = toast(`Toast at ${position}`, {
                  id: position,
                });
                // Update the toaster position (in real app, you'd control this via state)
                setTimeout(() => toast.dismiss(id), 3000);
              }}
            >
              {position}
            </Button>
          ))}
        </div>
        <div className="mt-4 text-sm text-muted-foreground text-center">
          Note: Position changes require updating the Toaster component prop
        </div>
      </>
    );
  },
};

// Toast with description
export const WithDescription: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() =>
            toast('Event Created', {
              description: 'Your event has been created successfully.',
            })
          }
        >
          Simple Description
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.success('File uploaded', {
              description:
                'Your file document.pdf has been uploaded successfully.',
            })
          }
        >
          Success with Description
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.error('Upload failed', {
              description: 'The file size exceeds the maximum limit of 10MB.',
            })
          }
        >
          Error with Description
        </Button>
      </div>
    </>
  ),
};

// Toast with actions
export const WithActions: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() =>
            toast('Message sent', {
              action: {
                label: 'Undo',
                onClick: () => console.log('Undo clicked'),
              },
            })
          }
        >
          With Undo Action
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Meeting scheduled', {
              description:
                'Your meeting has been scheduled for tomorrow at 10 AM.',
              action: {
                label: 'View',
                onClick: () => console.log('View clicked'),
              },
            })
          }
        >
          With View Action
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.error('Connection failed', {
              description: 'Unable to connect to the server.',
              action: {
                label: 'Retry',
                onClick: () => {
                  toast.success('Connected!');
                },
              },
            })
          }
        >
          With Retry Action
        </Button>
      </div>
    </>
  ),
};

// Custom duration
export const CustomDuration: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() =>
            toast('Quick toast (2s)', {
              duration: 2000,
            })
          }
        >
          2 Seconds
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Normal toast (4s)', {
              duration: 4000,
            })
          }
        >
          4 Seconds
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Long toast (10s)', {
              duration: 10000,
            })
          }
        >
          10 Seconds
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Persistent toast', {
              duration: Infinity,
            })
          }
        >
          Persistent (Manual dismiss)
        </Button>
      </div>
    </>
  ),
};

// Loading state
export const LoadingState: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() => {
            const id = toast.loading('Uploading file...');
            setTimeout(() => {
              toast.success('File uploaded successfully!', { id });
            }, 3000);
          }}
        >
          Loading → Success
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const id = toast.loading('Processing upload...');
            setTimeout(() => {
              toast.error('Upload failed. Please try again.', { id });
            }, 3000);
          }}
        >
          Loading → Error
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const id = toast.loading('Saving changes...');
            setTimeout(() => {
              toast.success('Changes saved!', {
                id,
                description: 'Your document has been updated.',
              });
            }, 2000);
          }}
        >
          Loading → Success with Description
        </Button>
      </div>
    </>
  ),
};

// Promise-based toasts
export const PromiseBased: Story = {
  render: () => {
    const createPromise = (shouldSucceed: boolean, delay: number = 2000) =>
      new Promise<{ name: string }>((resolve, reject) => {
        setTimeout(() => {
          if (shouldSucceed) {
            resolve({ name: 'Document.pdf' });
          } else {
            reject(new Error('Network error'));
          }
        }, delay);
      });

    return (
      <>
        <Toaster />
        <div className="flex flex-wrap gap-4">
          <Button
            onClick={() =>
              toast.promise(createPromise(true), {
                loading: 'Uploading file...',
                success: (data) => `${data.name} uploaded successfully`,
                error: 'Failed to upload file',
              })
            }
          >
            Promise Success
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast.promise(createPromise(false), {
                loading: 'Processing request...',
                success: 'Request completed',
                error: (err) => `Error: ${err.message}`,
              })
            }
          >
            Promise Error
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast.promise(createPromise(true, 3000), {
                loading: 'Saving your work...',
                success: 'All changes saved!',
                error: 'Failed to save changes',
                description: 'This may take a moment',
              })
            }
          >
            Promise with Description
          </Button>
        </div>
      </>
    );
  },
};

// Multiple toasts
export const MultipleToasts: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() => {
            toast('First notification');
            setTimeout(() => toast.success('Second notification'), 500);
            setTimeout(() => toast.info('Third notification'), 1000);
            setTimeout(() => toast.warning('Fourth notification'), 1500);
          }}
        >
          Show Multiple
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            for (let i = 1; i <= 5; i++) {
              setTimeout(() => {
                toast(`Notification ${i} of 5`);
              }, i * 300);
            }
          }}
        >
          Stacked Notifications
        </Button>
        <Button variant="destructive" onClick={() => toast.dismiss()}>
          Dismiss All
        </Button>
      </div>
    </>
  ),
};

// Custom styled toasts
export const CustomStyled: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() =>
            toast.custom((_id) => (
              <div className="flex items-center gap-2 bg-gradient-to-r from-blue-500 to-purple-500 text-white p-4 rounded-lg">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Custom styled toast!</span>
              </div>
            ))
          }
        >
          Gradient Toast
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.custom((_id) => (
              <div className="bg-background border-2 border-dashed border-primary p-4 rounded-lg">
                <div className="font-semibold mb-1">🎉 Celebration!</div>
                <div className="text-sm text-muted-foreground">
                  You&apos;ve achieved something great!
                </div>
              </div>
            ))
          }
        >
          Dashed Border
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.custom((_id) => (
              <div className="bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 p-4 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">⚠️</span>
                  <div>
                    <div className="font-semibold text-yellow-900 dark:text-yellow-100">
                      Important Notice
                    </div>
                    <div className="text-sm text-yellow-700 dark:text-yellow-300">
                      Please review the updated terms
                    </div>
                  </div>
                </div>
              </div>
            ))
          }
        >
          Warning Style
        </Button>
      </div>
    </>
  ),
};

// Close button and dismissible
export const Dismissible: Story = {
  render: () => (
    <>
      <Toaster closeButton />
      <div className="flex flex-wrap gap-4">
        <Button
          onClick={() =>
            toast('This toast has a close button', {
              duration: Infinity,
            })
          }
        >
          With Close Button
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const id = toast('Click me to dismiss', {
              duration: Infinity,
            });
            // Dismiss on click can be handled differently
            setTimeout(() => {
              const toastElement = document.querySelector(
                `[data-sonner-toast="${id}"]`,
              );
              if (toastElement) {
                toastElement.addEventListener('click', () => toast.dismiss(id));
              }
            }, 100);
          }}
        >
          Click to Dismiss
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast('Swipe to dismiss', {
              description: 'You can swipe this toast to dismiss it',
              duration: 10000,
            })
          }
        >
          Swipeable
        </Button>
      </div>
    </>
  ),
};

// Rich colors
export const RichColors: Story = {
  render: () => (
    <>
      <Toaster richColors expand />
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Button
            onClick={() => toast.success('Success with rich colors!')}
            className="bg-green-500 hover:bg-green-600"
          >
            Rich Success
          </Button>
          <Button
            onClick={() => toast.error('Error with rich colors!')}
            className="bg-red-500 hover:bg-red-600"
          >
            Rich Error
          </Button>
          <Button
            onClick={() => toast.warning('Warning with rich colors!')}
            className="bg-yellow-500 hover:bg-yellow-600"
          >
            Rich Warning
          </Button>
          <Button
            onClick={() => toast.info('Info with rich colors!')}
            className="bg-blue-500 hover:bg-blue-600"
          >
            Rich Info
          </Button>
        </div>
        <div className="text-sm text-muted-foreground">
          Rich colors provide better visual distinction between toast types
        </div>
      </div>
    </>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    position: 'bottom-right',
    richColors: false,
    expand: false,
    closeButton: false,
  },
  render: (args) => (
    <>
      <Toaster {...args} />
      <div className="flex flex-wrap gap-4">
        <Button onClick={() => toast('Playground toast notification')}>
          Show Toast
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.success('Success notification')}
        >
          Success
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.error('Error notification')}
        >
          Error
        </Button>
      </div>
    </>
  ),
};
