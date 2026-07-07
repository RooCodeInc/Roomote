type ReviewerSelectionState = {
  reviewerAuthorReviewMode: 'all' | 'specific' | 'none';
  reviewerCollaborators: string[];
};

const ALL_AUTHORS_VALUE = '__all_authors__';
const MENTIONS_ONLY_VALUE = '__mentions_only__';

export function applyReviewerAuthorSelection<T extends ReviewerSelectionState>(
  prev: T,
  values: string[],
): T {
  const hasAllAuthors = values.includes(ALL_AUTHORS_VALUE);
  const hasMentionsOnly = values.includes(MENTIONS_ONLY_VALUE);
  const specificValues = values.filter(
    (value) => value !== ALL_AUTHORS_VALUE && value !== MENTIONS_ONLY_VALUE,
  );

  if (hasAllAuthors && hasMentionsOnly) {
    if (prev.reviewerAuthorReviewMode === 'all') {
      return {
        ...prev,
        reviewerAuthorReviewMode: 'none',
        reviewerCollaborators: [],
      };
    }

    return {
      ...prev,
      reviewerAuthorReviewMode: 'all',
      reviewerCollaborators: [],
    };
  }

  if (hasAllAuthors) {
    if (prev.reviewerAuthorReviewMode === 'all' && specificValues.length > 0) {
      return {
        ...prev,
        reviewerAuthorReviewMode: 'specific',
        reviewerCollaborators: specificValues,
      };
    }

    return {
      ...prev,
      reviewerAuthorReviewMode: 'all',
      reviewerCollaborators: [],
    };
  }

  if (hasMentionsOnly) {
    if (prev.reviewerAuthorReviewMode === 'none' && specificValues.length > 0) {
      return {
        ...prev,
        reviewerAuthorReviewMode: 'specific',
        reviewerCollaborators: specificValues,
      };
    }

    return {
      ...prev,
      reviewerAuthorReviewMode: 'none',
      reviewerCollaborators: [],
    };
  }

  return {
    ...prev,
    reviewerAuthorReviewMode: 'specific',
    reviewerCollaborators: specificValues,
  };
}
