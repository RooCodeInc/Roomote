'use client';

import { memo, useRef, useEffect, useState } from 'react';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { LayoutGrid } from '@/components/system';

import { type TaskArtifact, useTaskSidePanel } from '../hooks';

import type { SidebarActionBaseProps } from './types';

interface ArtifactsButtonProps extends SidebarActionBaseProps {
  artifacts: TaskArtifact[];
  disabled?: boolean;
}

function ArtifactsButtonBase({
  artifacts,
  disabled: disabledUntilReady = false,
}: ArtifactsButtonProps) {
  const { openArtifactsBrowser, closeSidePanel, isViewActive } =
    useTaskSidePanel();

  const [highlight, setHighlight] = useState(false);

  const hasArtifacts = artifacts.length > 0;
  const prevCountRef = useRef(artifacts.length);

  useEffect(() => {
    if (prevCountRef.current === 0 && artifacts.length > 0) {
      setHighlight(true);
    }

    prevCountRef.current = artifacts.length;
  }, [artifacts.length]);

  const artifactsViewActive = isViewActive('artifacts');
  const disabled = disabledUntilReady || !hasArtifacts;

  return (
    <SideNavItem
      side="right"
      label="Artifacts"
      tooltip={disabledUntilReady ? undefined : 'Artifacts'}
      description={
        disabledUntilReady
          ? undefined
          : hasArtifacts
            ? 'Non-code agent-created items'
            : 'No artifacts in this task yet'
      }
      highlight={hasArtifacts && highlight}
      icon={LayoutGrid}
      active={!disabled && artifactsViewActive}
      disabled={disabled}
      onClick={
        disabled
          ? undefined
          : () => {
              if (highlight) {
                setHighlight(false);
              }
              if (artifactsViewActive) {
                closeSidePanel();
              } else {
                openArtifactsBrowser();
              }
            }
      }
    />
  );
}

export const ArtifactsButton = memo(ArtifactsButtonBase);
