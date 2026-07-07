import type { CursorPaginationControls } from '@/hooks/usePagination';

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '../primitives/pagination';

interface CursorPaginationProps {
  pagination: CursorPaginationControls;
  className?: string;
  scrollTargetRef?: React.RefObject<HTMLElement | null>;
}

export const CursorPagination = ({
  pagination,
  scrollTargetRef,
}: CursorPaginationProps) => {
  const {
    hasNextPage,
    hasPreviousPage,
    nextPage,
    previousPage,
    currentPageIndex,
  } = pagination;

  const scrollToTarget = () => {
    // Wait longer to ensure React Query has fetched and rendered new content
    setTimeout(() => {
      if (scrollTargetRef?.current) {
        // Use scrollIntoView for more reliable scrolling
        scrollTargetRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });

        // Add a small offset to account for sticky headers
        // We do this after scrollIntoView to maintain smooth scrolling
        setTimeout(() => {
          const currentScroll = window.pageYOffset;
          window.scrollTo({
            top: currentScroll - 80, // Offset for sticky header
            behavior: 'auto', // Use auto to avoid double animation
          });
        }, 50);
      }
    }, 300);
  };

  const handleNextPage = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    nextPage();
    scrollToTarget();
  };

  const handlePreviousPage = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    previousPage();
    scrollToTarget();
  };

  // Don't show pagination if we're on the first page and there's no next page.
  if (currentPageIndex === 0 && !hasNextPage) {
    return null;
  }

  return (
    <Pagination>
      <PaginationContent>
        {hasPreviousPage && (
          <PaginationItem>
            <PaginationPrevious href="#" onClick={handlePreviousPage} />
          </PaginationItem>
        )}
        {hasNextPage && (
          <PaginationItem>
            <PaginationNext href="#" onClick={handleNextPage} />
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
};
