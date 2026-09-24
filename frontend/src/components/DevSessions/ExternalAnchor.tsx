'use client';

import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

/** Opens in the system browser — target="_blank" does nothing inside the Tauri webview. */
export const ExternalAnchor = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(
  ({ href, onClick, ...props }, ref) => (
    <a
      ref={ref}
      href={href}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
        invoke('open_external_url', { url: href }).catch((err) =>
          toast.error('Could not open link', { description: String(err) })
        );
      }}
      {...props}
    />
  )
);
ExternalAnchor.displayName = 'ExternalAnchor';
