'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { AttachmentData } from './attachments';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from './attachments';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockImage: AttachmentData = {
  id: 'img-1',
  type: 'file',
  url: 'https://picsum.photos/200/200',
  mediaType: 'image/jpeg',
  filename: 'screenshot.png',
};

const mockDocument: AttachmentData = {
  id: 'doc-1',
  type: 'file',
  url: '',
  mediaType: 'application/pdf',
  filename: 'architecture.pdf',
};

const mockAudio: AttachmentData = {
  id: 'audio-1',
  type: 'file',
  url: '',
  mediaType: 'audio/mpeg',
  filename: 'recording.mp3',
};

const mockVideo: AttachmentData = {
  id: 'video-1',
  type: 'file',
  url: '',
  mediaType: 'video/mp4',
  filename: 'demo.mp4',
};

const mockSource: AttachmentData = {
  id: 'src-1',
  type: 'source-document',
  title: 'API Documentation',
  filename: 'api-docs.md',
  mediaType: 'text/markdown',
  sourceId: 'src-1',
};

const mockUnknown: AttachmentData = {
  id: 'unk-1',
  type: 'file',
  url: '',
  mediaType: '',
  filename: 'data.bin',
};

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/Attachments',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Grid Variant
// ---------------------------------------------------------------------------

export const GridVariant: Story = {
  name: 'Grid – Images',
  render: () => (
    <Attachments variant="grid">
      <Attachment data={mockImage}>
        <AttachmentPreview />
      </Attachment>
      <Attachment data={{ ...mockImage, id: 'img-2', filename: 'photo-2.jpg' }}>
        <AttachmentPreview />
      </Attachment>
      <Attachment data={{ ...mockImage, id: 'img-3', filename: 'photo-3.jpg' }}>
        <AttachmentPreview />
      </Attachment>
    </Attachments>
  ),
};

export const GridMixedMedia: Story = {
  name: 'Grid – Mixed Media',
  render: () => (
    <Attachments variant="grid">
      <Attachment data={mockImage}>
        <AttachmentPreview />
      </Attachment>
      <Attachment data={mockVideo}>
        <AttachmentPreview />
      </Attachment>
      <Attachment data={mockDocument}>
        <AttachmentPreview />
      </Attachment>
      <Attachment data={mockAudio}>
        <AttachmentPreview />
      </Attachment>
    </Attachments>
  ),
};

// ---------------------------------------------------------------------------
// Inline Variant
// ---------------------------------------------------------------------------

export const InlineVariant: Story = {
  name: 'Inline – Documents',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockDocument}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
      <Attachment
        data={{
          ...mockDocument,
          id: 'doc-2',
          filename: 'requirements.pdf',
        }}
      >
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  ),
};

export const InlineWithRemove: Story = {
  name: 'Inline – With Remove',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockImage} onRemove={() => console.log('remove image')}>
        <AttachmentPreview />
        <AttachmentInfo />
        <AttachmentRemove />
      </Attachment>
      <Attachment
        data={mockDocument}
        onRemove={() => console.log('remove doc')}
      >
        <AttachmentPreview />
        <AttachmentInfo />
        <AttachmentRemove />
      </Attachment>
    </Attachments>
  ),
};

// ---------------------------------------------------------------------------
// List Variant
// ---------------------------------------------------------------------------

export const ListVariant: Story = {
  name: 'List – All Types',
  render: () => (
    <Attachments variant="list">
      <Attachment data={mockImage}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
      <Attachment data={mockDocument}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
      <Attachment data={mockAudio}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
      <Attachment data={mockVideo}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
      <Attachment data={mockSource}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
      <Attachment data={mockUnknown}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
    </Attachments>
  ),
};

// ---------------------------------------------------------------------------
// Individual Types
// ---------------------------------------------------------------------------

export const ImageAttachment: Story = {
  name: 'Single – Image',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockImage}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  ),
};

export const DocumentAttachment: Story = {
  name: 'Single – Document',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockDocument}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  ),
};

export const AudioAttachment: Story = {
  name: 'Single – Audio',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockAudio}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  ),
};

export const SourceAttachment: Story = {
  name: 'Single – Source Document',
  render: () => (
    <Attachments variant="inline">
      <Attachment data={mockSource}>
        <AttachmentPreview />
        <AttachmentInfo />
      </Attachment>
    </Attachments>
  ),
};
