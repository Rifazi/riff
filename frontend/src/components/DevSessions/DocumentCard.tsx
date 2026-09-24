'use client';

import React from 'react';
import { Loader2, Pencil, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownDocument } from './MarkdownDocument';
import { ErrorText } from './PageShell';

interface DocumentCardProps {
  title: string;
  subtitle?: string | null;
  markdown: string | null | undefined;
  emptyText: string;
  badge?: React.ReactNode;
  notices?: React.ReactNode;
  footer?: React.ReactNode;
  /** Omit to make the document read-only. */
  editing?: {
    canEdit: boolean;
    isEditing: boolean;
    editLabel: string;
    draft: string;
    onDraftChange: (value: string) => void;
    onStart: () => void;
    onCancel: () => void;
    onSave: () => void;
    saving: boolean;
    error?: string | null;
  };
}

export function DocumentCard({ title, subtitle, markdown, emptyText, badge, notices, footer, editing }: DocumentCardProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {subtitle && <div className="text-xs text-gray-500 font-mono truncate">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {badge}
          {editing?.canEdit && !editing.isEditing && (
            <Button size="sm" variant="outline" onClick={editing.onStart}>
              <Pencil />
              {editing.editLabel}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-4">
        {notices && <div className="space-y-2 mb-3">{notices}</div>}
        {editing?.isEditing ? (
          <textarea
            value={editing.draft}
            onChange={(e) => editing.onDraftChange(e.target.value)}
            className="w-full h-full min-h-[40vh] px-3 py-2 border border-gray-200 rounded-md font-mono text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none"
          />
        ) : markdown ? (
          <MarkdownDocument markdown={markdown} />
        ) : (
          <div className="py-8 text-center text-sm text-gray-500">{emptyText}</div>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-4">
        {editing?.isEditing && (
          <div className="pt-3 border-t border-gray-100">
            <ErrorText>{editing.error}</ErrorText>
            <div className="flex gap-2 mt-2">
              <Button variant="blue" onClick={editing.onSave} disabled={!editing.draft.trim() || editing.saving}>
                {editing.saving ? <Loader2 className="animate-spin" /> : <Save />}
                {editing.saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="outline" onClick={editing.onCancel} disabled={editing.saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {footer}
      </div>
    </div>
  );
}
