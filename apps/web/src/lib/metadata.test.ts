import { describe, expect, it } from 'vitest';

import { createPageMetadata, PAGE_METADATA } from './metadata';

describe('createPageMetadata', () => {
  it('sets title and description without open graph images', () => {
    const metadata = createPageMetadata({
      title: 'Roomote Task',
      description: 'View and continue a Roomote task.',
    });

    expect(metadata.title).toBe('Roomote Task');
    expect(metadata.description).toBe('View and continue a Roomote task.');
    expect(metadata.openGraph).toEqual({
      title: 'Roomote Task',
      description: 'View and continue a Roomote task.',
    });
    expect(metadata.twitter).toEqual({
      title: 'Roomote Task',
      description: 'View and continue a Roomote task.',
    });
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });
});

describe('PAGE_METADATA', () => {
  it('uses the static product titles and descriptions', () => {
    expect(PAGE_METADATA.task.title).toBe('Roomote Task');
    expect(PAGE_METADATA.settings.title).toBe('Roomote Settings');
    expect(PAGE_METADATA.taskHistory.title).toBe('Roomote Task History');
    expect(PAGE_METADATA.logIn.title).toBe('Roomote Log In');
    expect(PAGE_METADATA.signUp.title).toBe('Roomote Sign up');
    expect(PAGE_METADATA.setup.title).toBe('Roomote Setup');
    expect(PAGE_METADATA.onboarding.title).toBe('Roomote Onboarding');

    for (const entry of Object.values(PAGE_METADATA)) {
      expect(entry.description).toEqual(expect.any(String));
      expect((entry.description ?? '').length).toBeGreaterThan(0);
      expect(entry.openGraph).not.toHaveProperty('images');
    }
  });

  it('keeps login and signup titles distinct and static', () => {
    expect(PAGE_METADATA.logIn.title).not.toEqual(PAGE_METADATA.signUp.title);
    expect(PAGE_METADATA.logIn.description).not.toContain('task');
    expect(PAGE_METADATA.signUp.description).not.toContain('task');
  });
});

describe('sign-in metadata eligibility', () => {
  it('documents that sign-up titles require form eligibility plus invite', () => {
    // Contract reminder for page generateMetadata: invited alone is not enough.
    // Keep the static strings available; route wiring gates them with
    // canVisitorSignUp() && invited.
    expect(PAGE_METADATA.signUp.title).toBe('Roomote Sign up');
    expect(PAGE_METADATA.logIn.title).toBe('Roomote Log In');
  });
});
