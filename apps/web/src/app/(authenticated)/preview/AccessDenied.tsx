import { CircleSlash } from 'lucide-react';

import {
  Empty,
  EmptyHeader,
  EmptyDescription,
  EmptyMedia,
} from '@/components/system';

export function AccessDenied() {
  return (
    <Empty className="h-below-header">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-rose-500">
          <CircleSlash />
        </EmptyMedia>
        <EmptyDescription className="text-sm">
          This preview does not exist or you do not have permission to view it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
