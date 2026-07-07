import { useEffect, useState } from 'react';

export interface UseRealtimePollingOptions {
  enabled?: boolean;
  interval?: number;
  retry?: number;
}

interface UseRealtimePollingResult {
  refetchInterval: number | false;
  refetchIntervalInBackground: false;
  retry: number;
  isVisible: boolean;
}

export const useRealtimePolling = ({
  enabled = true,
  interval = 3000,
  retry = 3,
}: UseRealtimePollingOptions = {}): UseRealtimePollingResult => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    // Automatically pauses polling when the tab is not visible.
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return {
    refetchInterval: enabled && isVisible ? interval : false,
    refetchIntervalInBackground: false,
    retry,
    isVisible,
  };
};
