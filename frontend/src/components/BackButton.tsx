'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface BackButtonProps {
  /** Where to go when there is no earlier page to return to. */
  fallbackHref: string;
  /** Skip history and always go to `fallbackHref`, e.g. after a recording flow. */
  preferFallback?: boolean;
  className?: string;
}

/** True when the webview has an earlier history entry to go back to. */
function canGoBack(): boolean {
  // The Navigation API knows the current position; history.length only counts entries.
  const navigation = (window as { navigation?: { canGoBack?: boolean } }).navigation;
  if (typeof navigation?.canGoBack === 'boolean') return navigation.canGoBack;
  return window.history.length > 1;
}

/**
 * The app's one back button: returns to the previous page, or to
 * `fallbackHref` when the page was opened with nothing to go back to.
 */
export function BackButton({ fallbackHref, preferFallback = false, className = '' }: BackButtonProps) {
  const router = useRouter();

  const handleClick = () => {
    if (!preferFallback && canGoBack()) router.back();
    else router.push(fallbackHref);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors ${className}`}
    >
      <ArrowLeft className="h-4 w-4" /> Back
    </button>
  );
}
