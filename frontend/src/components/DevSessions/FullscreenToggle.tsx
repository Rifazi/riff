'use client';

import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Classes that lift a card over the whole window. The card stays mounted in place, so its scroll, draft and edit state survive. */
const FULLSCREEN_CLASS = 'fixed inset-0 z-50 !rounded-none !m-0 !h-auto';

/** Full-screen state for a pane: spread `className` on the card and render `button` in its header. Escape exits. */
export function useFullscreen(label: string) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const button = (
    <Button
      size="icon"
      variant="ghost"
      className="h-8 w-8"
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? 'Exit full screen (Esc)' : `Open ${label} full screen`}
    >
      {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
    </Button>
  );

  return { expanded, className: expanded ? FULLSCREEN_CLASS : '', button };
}
