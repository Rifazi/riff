'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The one-line, click-to-open row the Coding and QA tabs use for everything
 * that isn't the live conversation: checklists, notes for QA, commits,
 * earlier team rounds. Closed by default so the chat and the diff/report
 * keep the room.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  aside,
  actions,
  peek,
  defaultOpen = false,
  bare,
  className,
  bodyClassName,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ElementType;
  /** Muted text after the title — a count, "3 of 7 done". */
  aside?: React.ReactNode;
  /** Right-aligned controls, outside the toggle so clicking them doesn't open it. */
  actions?: React.ReactNode;
  /** Always shown under the header, open or not — e.g. a progress bar, or the current step while closed. */
  peek?: React.ReactNode | ((open: boolean) => React.ReactNode);
  defaultOpen?: boolean;
  /** No card around it, for use inside another card. */
  bare?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const peeked = typeof peek === 'function' ? peek(open) : peek;

  const content = (
    <>
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 py-2 text-left text-sm rounded-md hover:bg-muted transition-colors',
            bare ? 'px-1' : 'pl-3 pr-1',
          )}
        >
          <ChevronDown
            className={`w-4 h-4 flex-shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {Icon && <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />}
          <span className="font-medium text-foreground truncate">{title}</span>
          {aside != null && aside !== false && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">{aside}</span>
          )}
        </button>
        {actions && <div className="flex items-center gap-3 flex-shrink-0">{actions}</div>}
      </div>
      {peeked && <div className={bare ? 'px-1 pb-2' : 'px-3 pb-2'}>{peeked}</div>}
      {open && (
        <div className={cn(bare ? 'pt-1 pb-2 px-1' : 'border-t border-border p-3', bodyClassName)}>{children}</div>
      )}
    </>
  );

  return bare ? (
    <div className={className}>{content}</div>
  ) : (
    <Card className={cn('flex-shrink-0 overflow-hidden', className)}>{content}</Card>
  );
}
