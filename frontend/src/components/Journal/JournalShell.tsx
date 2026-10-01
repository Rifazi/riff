'use client';

import React from 'react';

interface JournalShellProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown above the title, e.g. a back link. */
  eyebrow?: React.ReactNode;
  children: React.ReactNode;
}

export function JournalShell({ title, subtitle, actions, eyebrow, children }: JournalShellProps) {
  return (
    <div className="h-screen bg-stone-50 flex flex-col min-w-0">
      <div className="flex-shrink-0 border-b border-stone-200 bg-stone-50">
        <div className="px-8 py-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && <div className="mb-1 text-sm text-gray-500">{eyebrow}</div>}
            <h1 className="text-2xl font-bold text-gray-900 truncate">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-gray-500">{subtitle}</div>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-7xl mx-auto px-8 py-6">{children}</div>
      </div>
    </div>
  );
}
