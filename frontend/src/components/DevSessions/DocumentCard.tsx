'use client';

import React from 'react';
import { Pencil, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
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

export function DocumentCard({
  title,
  subtitle,
  markdown,
  emptyText,
  badge,
  notices,
  footer,
  editing,
}: DocumentCardProps) {
  return (
    <Card className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && <div className="text-xs text-muted-foreground font-mono truncate">{subtitle}</div>}
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
          <Textarea
            value={editing.draft}
            onChange={(e) => editing.onDraftChange(e.target.value)}
            className="w-full h-full min-h-[40vh] font-mono text-xs resize-none"
          />
        ) : markdown ? (
          <MarkdownDocument markdown={markdown} />
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">{emptyText}</div>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-4">
        {editing?.isEditing && (
          <div className="pt-3 border-t border-border">
            <ErrorText>{editing.error}</ErrorText>
            <div className="flex gap-2 mt-2">
              <Button onClick={editing.onSave} disabled={!editing.draft.trim() || editing.saving}>
                {editing.saving ? <Spinner size="sm" className="text-current" /> : <Save />}
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
    </Card>
  );
}
