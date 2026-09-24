'use client';

import React from 'react';
import { AgentServerBanner } from './AgentServerBanner';

interface PageShellProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Full-height content (e.g. chat + document split) instead of a scrolling column. */
  fill?: boolean;
}

export function PageShell({ title, subtitle, actions, children, fill }: PageShellProps) {
  return (
    <div className="h-screen bg-gray-50 flex flex-col min-w-0">
      <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50">
        <div className="px-8 py-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-gray-500">{subtitle}</div>}
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

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white rounded-lg border border-gray-200 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
          {title && <h2 className="text-sm font-semibold text-gray-900">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-gray-100 text-gray-700 border-gray-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
};

export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <div className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}>{children}</div>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <div className="text-sm text-red-600 mt-2">{children}</div>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="py-10 text-center text-sm text-gray-500">{label}</div>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg bg-white">
      {children}
    </div>
  );
}
