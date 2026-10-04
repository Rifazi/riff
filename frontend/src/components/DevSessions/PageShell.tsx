'use client';

import React from 'react';
import { Page, PageBody, PageHeader } from '@/components/ui/page';
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

/** The app's standard page (`ui/page`) plus the agent-server banner every Dev Sessions page shows. */
export function PageShell({ title, subtitle, actions, back, children, fill }: PageShellProps) {
  return (
    <Page>
      <PageHeader title={title} subtitle={subtitle} actions={actions} back={back} />
      <AgentServerBanner />
      <PageBody fill={fill} className={fill ? 'px-8 py-4' : undefined}>
        {children}
      </PageBody>
    </Page>
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
