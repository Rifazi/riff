'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The one page frame every top-level screen uses: the page background, the
 * title bar and the body below it. Screens never set their own page
 * background or hand-roll a header — compose these instead, so every module
 * sits on the same surface (`bg-background`) under the same title bar.
 *
 *   <Page>
 *     <PageHeader title="Meetings" subtitle="…" actions={<Button />} />
 *     <PageBody>…</PageBody>
 *   </Page>
 *
 * Content panels inside the body are `Card`s (`bg-card`); the page itself is
 * never `bg-muted` or `bg-card`.
 */
const Page = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex h-screen min-w-0 flex-col bg-background', className)} {...props} />
  ),
);
Page.displayName = 'Page';

interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned buttons. */
  actions?: React.ReactNode;
  /** Shown above the title, usually a <BackButton>. */
  back?: React.ReactNode;
}

function PageHeader({ title, subtitle, actions, back, className, children, ...props }: PageHeaderProps) {
  return (
    <header className={cn('flex-shrink-0 border-b border-border bg-background', className)} {...props}>
      <div className="flex items-center justify-between gap-4 px-8 py-5">
        <div className="min-w-0">
          {back && <div className="mb-1">{back}</div>}
          <h1 className="truncate text-2xl font-bold text-foreground">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Full-height content (a split view, chat + document) instead of a scrolling column. */
  fill?: boolean;
  /** A wider column for card grids. */
  wide?: boolean;
}

function PageBody({ fill, wide, className, children, ...props }: PageBodyProps) {
  if (fill) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col', className)} {...props}>
        {children}
      </div>
    );
  }
  return (
    <div className="custom-scrollbar flex-1 overflow-y-auto" {...props}>
      <div className={cn('mx-auto px-8 py-6', wide ? 'max-w-7xl' : 'max-w-6xl', className)}>{children}</div>
    </div>
  );
}

export { Page, PageHeader, PageBody };
