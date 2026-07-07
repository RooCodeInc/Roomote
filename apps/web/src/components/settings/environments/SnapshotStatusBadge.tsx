'use client';

import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  Badge,
  BasicTooltip,
  Camera,
  CheckCircle2,
  Clock,
  Loader2,
} from '@/components/system';

import type { SnapshotStatus } from '@/trpc/commands/environments';

interface SnapshotStatusBadgeProps {
  status: SnapshotStatus;
  expiresAt?: Date | null;
  createdAt?: Date | null;
}

export function SnapshotStatusBadge({
  status,
  expiresAt,
  createdAt,
}: SnapshotStatusBadgeProps) {
  const getVariant = () => {
    switch (status) {
      case 'ready':
        return 'success';
      case 'pending':
        return 'secondary';
      case 'expired':
      case 'failed':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const getIcon = () => {
    switch (status) {
      case 'ready':
        return <CheckCircle2 className="size-3" />;
      case 'pending':
        return <Loader2 className="size-3 animate-spin" />;
      case 'expired':
        return <Clock className="size-3" />;
      case 'failed':
        return <AlertCircle className="size-3" />;
      default:
        return <Camera className="size-3" />;
    }
  };

  const getLabel = () => {
    switch (status) {
      case 'ready':
        if (expiresAt) {
          const now = new Date();
          const isExpiringSoon =
            expiresAt.getTime() - now.getTime() < 24 * 60 * 60 * 1000;

          if (isExpiringSoon) {
            return `Expires ${formatDistanceToNow(expiresAt, { addSuffix: true })}`;
          }
        }

        return 'Snapshot Ready';
      case 'pending':
        return 'Snapshotting...';
      case 'expired':
        return 'Expired';
      case 'failed':
        return 'Failed';
      default:
        return status;
    }
  };

  const getTooltipContent = () => {
    switch (status) {
      case 'ready':
        return (
          <div className="space-y-1">
            <p>Snapshot is ready for faster startups.</p>
            {createdAt && (
              <p className="text-card/70">
                Created {formatDistanceToNow(createdAt, { addSuffix: true })}
              </p>
            )}
            {expiresAt && (
              <p className="text-card/70">
                Expires {formatDistanceToNow(expiresAt, { addSuffix: true })}
              </p>
            )}
          </div>
        );
      case 'pending':
        return 'Snapshot creation in progress. This may take a few minutes.';
      case 'expired':
        return 'Snapshot has expired. Create a new snapshot for faster startups.';
      case 'failed':
        return 'Snapshot creation failed. Click to retry.';
      default:
        return null;
    }
  };

  return (
    <BasicTooltip
      content={<div className="text-sm">{getTooltipContent()}</div>}
    >
      <Badge variant={getVariant()} className="gap-1">
        {getIcon()}
        {getLabel()}
      </Badge>
    </BasicTooltip>
  );
}
