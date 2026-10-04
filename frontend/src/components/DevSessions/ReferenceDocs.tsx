'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Library, Plus, Share2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import { ACCEPTED_ATTACHMENT_TYPES, readAttachments } from '@/lib/dev-sessions/attachments';
import type { AttachmentInput, ReferenceDoc, SessionRecord } from '@/lib/dev-sessions/types';
import { ErrorText } from './PageShell';

// Documents the agents can read without them being re-attached in every
// stage (harness-server's sessions/reference-docs.ts). Chat attachments land
// in the session's list automatically; this is where they're reviewed,
// removed, shared with the whole app, or added up front.

const REFERENCE_DOCS_KEY = ['reference-docs'];

export function useInvalidateReferenceDocs() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: REFERENCE_DOCS_KEY });
}

/** Header button on a session: its own documents plus its app's. */
export function SessionReferenceDocsButton({ session }: { session: SessionRecord }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateReferenceDocs();
  const { data } = useQuery({
    queryKey: [...REFERENCE_DOCS_KEY, 'session', session.id],
    queryFn: () => api.listSessionReferenceDocs(session.id),
  });
  const mutationOptions = { onSuccess: invalidate, onError: (err: Error) => setError(err.message) };
  const addToSession = useMutation({
    mutationFn: (files: AttachmentInput[]) => api.addSessionReferenceDocs(session.id, files),
    ...mutationOptions,
  });
  const addToApp = useMutation({
    mutationFn: (files: AttachmentInput[]) => api.addAppReferenceDocs(session.appId, files),
    ...mutationOptions,
  });
  const removeFromSession = useMutation({
    mutationFn: (docId: string) => api.removeSessionReferenceDoc(session.id, docId),
    ...mutationOptions,
  });
  const removeFromApp = useMutation({
    mutationFn: (docId: string) => api.removeAppReferenceDoc(session.appId, docId),
    ...mutationOptions,
  });
  const share = useMutation({
    mutationFn: (docId: string) => api.shareReferenceDocWithApp(session.id, docId),
    ...mutationOptions,
  });

  const count = (data?.app.length ?? 0) + (data?.session.length ?? 0);
  const busy = addToSession.isPending || addToApp.isPending;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} title="Documents every agent in this session can read">
        <Library />
        Reference docs{count > 0 ? ` · ${count}` : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Reference docs</DialogTitle>
            <DialogDescription>
              Every agent in this session can search and read these, so you only attach a document once. Files you
              attach in a chat are added here automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <DocSection
              title="This session"
              hint="Requirements, plan, coding (including parallel workstreams) and QA."
              docs={data?.session}
              busy={busy}
              onAdd={(files) => addToSession.mutate(files)}
              onError={setError}
              onRemove={(doc) => removeFromSession.mutate(doc.id)}
              onShare={(doc) => share.mutate(doc.id)}
              shareLabel={`Share with every ${session.appName} session`}
            />
            <DocSection
              title={`Every ${session.appName} session`}
              hint="Documentation the app itself depends on, for this and all future sessions."
              docs={data?.app}
              busy={busy}
              onAdd={(files) => addToApp.mutate(files)}
              onError={setError}
              onRemove={(doc) => removeFromApp.mutate(doc.id)}
            />
            <ErrorText>{error}</ErrorText>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** For an app card on the Apps page: the documents shared by all of its sessions. */
export function AppReferenceDocsButton({ appId, appName }: { appId: string; appName: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateReferenceDocs();
  const { data } = useQuery({
    queryKey: [...REFERENCE_DOCS_KEY, 'app', appId],
    queryFn: () => api.listAppReferenceDocs(appId),
  });
  const mutationOptions = { onSuccess: invalidate, onError: (err: Error) => setError(err.message) };
  const add = useMutation({
    mutationFn: (files: AttachmentInput[]) => api.addAppReferenceDocs(appId, files),
    ...mutationOptions,
  });
  const remove = useMutation({
    mutationFn: (docId: string) => api.removeAppReferenceDoc(appId, docId),
    ...mutationOptions,
  });

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Library />
        Reference docs{data?.length ? ` · ${data.length}` : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{appName} reference docs</DialogTitle>
            <DialogDescription>
              Every agent in every {appName} session can search and read these: vendor API specs, file formats the app
              ingests, anything they&apos;d otherwise ask you to attach again.
            </DialogDescription>
          </DialogHeader>
          <DocSection
            title="Shared documents"
            docs={data}
            busy={add.isPending}
            onAdd={(files) => add.mutate(files)}
            onError={setError}
            onRemove={(doc) => remove.mutate(doc.id)}
          />
          <ErrorText>{error}</ErrorText>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocSection({
  title,
  hint,
  docs,
  busy,
  onAdd,
  onError,
  onRemove,
  onShare,
  shareLabel,
}: {
  title: string;
  hint?: string;
  docs: ReferenceDoc[] | undefined;
  busy: boolean;
  onAdd: (files: AttachmentInput[]) => void;
  onError: (message: string) => void;
  onRemove: (doc: ReferenceDoc) => void;
  onShare?: (doc: ReferenceDoc) => void;
  shareLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    try {
      onAdd(await readAttachments(fileList));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_ATTACHMENT_TYPES}
          hidden
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = '';
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Plus />
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {!docs ? null : docs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          None yet — PDFs or text/markdown files.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {docs.map((doc) => (
            <li key={doc.path} className="flex items-center gap-2 px-3 py-2">
              <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground truncate" title={doc.name}>
                  {doc.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {doc.chars.toLocaleString()} characters · added {new Date(doc.addedAt).toLocaleDateString()}
                </div>
              </div>
              {onShare && (
                <Button
                  size="icon"
                  variant="ghost"
                  title={shareLabel}
                  aria-label={shareLabel}
                  onClick={() => onShare(doc)}
                >
                  <Share2 />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                title={`Remove ${doc.name}`}
                aria-label={`Remove ${doc.name}`}
                onClick={() => onRemove(doc)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
