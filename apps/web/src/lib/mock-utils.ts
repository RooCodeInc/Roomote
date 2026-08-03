import type { UserResource } from '@/types';

export const mockUserResource: UserResource = {
  username: 'username',
  fullName: 'John Doe',
  firstName: 'John',
  lastName: 'Doe',
  primaryEmailAddress: {
    id: 'primary-email-address-id',
    emailAddress: 'john.doe@example.com',
  },
  emailAddresses: [
    { id: 'email-address-id', emailAddress: 'john.doe@example.com' },
  ],
  imageUrl: 'https://example.com/image.jpg',
  createdAt: new Date('2025-01-01'),
};
