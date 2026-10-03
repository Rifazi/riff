'use client';

import React from 'react';
import { AgentServerBanner } from './AgentServerBanner';

interface PageShellProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown above the title, usually a <BackButton>. */
  back?: React.ReactNode;
  children: React.ReactNode;
  /** Full-height content (e.g. chat + document split) instead of a scrolling column. */
  fill?: boolean;
}

export function PageShell({ title, subtitle, actions, back, children, fill }: PageShellProps) {
  return (
    <div className="h-screen bg-muted flex flex-col min-w-0">
      <div className="flex-shrink-0 border-b border-border bg-muted">
        <div className="px-8 py-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            {back && <div className="mb-1">{back}</div>}
            <h1 className="text-2xl font-bold text-foreground truncate">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      </div>
      <AgentServerBanner />
      {fill ? (
        <div className="flex-1 min-h-0 flex flex-col px-8 py-4">{children}</div>
      ) : (
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-6xl mx-auto px-8 py-6">{children}</div>
        </div>
      )}
    </div>
  );
}

type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber';

// Tones map onto the theme's semantic colors: blue→info, green→success,
// red→destructive, amber→warning. Kept here (rather than switching every
// call site's prop name) since `tone` is still the vocabulary the rest of
// Dev Sessions chrome uses for `Notice`.
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  blue: 'bg-info text-info-foreground border-info',
  green: 'bg-success text-success-foreground border-success',
  red: 'bg-destructive text-destructive-foreground border-destructive',
  amber: 'bg-warning text-warning-foreground border-warning',
};

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <div className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}>{children}</div>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <div className="text-sm text-destructive mt-2">{children}</div>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{label}</div>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground border border-dashed border-border rounded-lg bg-card">
      {children}
    </div>
  );
}
