'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, CheckCircle2, ChevronDown, FileCode2, Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiUrl } from '@/lib/dev-sessions/api';
import type { AppConfig, CheckCommands, Role } from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS, COORDINATOR_PERSONA } from '@/lib/dev-sessions/agents';
import { SESSIONS_HREF } from '@/lib/dev-sessions/stage';
import { Card, EmptyState, ErrorText, LoadingState, Notice, PageShell, Pill } from '@/components/DevSessions/PageShell';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { ExternalAnchor } from '@/components/DevSessions/ExternalAnchor';

const DEFAULT_CHECK_COMMANDS: Record<keyof CheckCommands, string> = {
  lint: 'lint',
  test: 'test:ci',
  'test:integration': 'test:integration',
};

const ROLES: { key: Role; label: string }[] = [
  { key: 'requirements', label: `Requirements — ${AGENT_PERSONAS.requirements.name}` },
  { key: 'plan', label: `Plan — ${AGENT_PERSONAS.plan.name}` },
  { key: 'coding', label: `Coding — ${AGENT_PERSONAS.coding.name}` },
  { key: 'qa', label: `QA — ${AGENT_PERSONAS.qa.name}` },
  { key: 'coordinator', label: `Coordinator — ${COORDINATOR_PERSONA.name}` },
];

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <Label className="text-gray-600">{label}</Label>
      {children}
    </div>
  );
}

function Disclosure({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onToggle} className="text-gray-600">
      <ChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      {label}
    </Button>
  );
}

function PromptRow({ appId, role, label }: { appId: string; role: Role; label: string }) {
  const queryClient = useQueryClient();
  const { data: prompts } = useQuery({ queryKey: ['app-prompts', appId], queryFn: () => api.getAppPrompts(appId) });
  const [draft, setDraft] = useState<string | null>(null);
  const [showBase, setShowBase] = useState(false);

  const prompt = prompts?.[role];
  const value = draft ?? prompt?.override ?? '';
  const dirty = draft !== null && draft !== (prompt?.override ?? '');

  const saveMutation = useMutation({
    mutationFn: (text: string | null) => api.setAppPrompt(appId, role, text),
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['app-prompts', appId] });
    },
  });

  if (!prompts) return null;

  return (
    <div className="space-y-2 py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-900">{label}</div>
        <Pill tone={prompt?.override ? 'blue' : 'neutral'}>{prompt?.override ? 'Customized' : 'Using default'}</Pill>
      </div>
      {prompt?.base && (
        <div>
          <button onClick={() => setShowBase((v) => !v)} className="text-xs text-blue-600 hover:underline">
            {showBase ? 'Hide default prompt' : 'View default prompt'}
          </button>
          {showBase && (
            <pre className="mt-2 max-h-60 overflow-auto custom-scrollbar text-xs bg-gray-50 border border-gray-200 rounded-md p-3 whitespace-pre-wrap">
              {prompt.base}
            </pre>
          )}
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Leave blank to use the default prompt for this app. An override replaces the default entirely."
        rows={5}
        className="w-full px-3 py-2 border border-gray-200 rounded-md font-mono text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="blue" disabled={!dirty || saveMutation.isPending} onClick={() => saveMutation.mutate(value)}>
          {saveMutation.isPending ? 'Saving…' : 'Save override'}
        </Button>
        {prompt?.override && (
          <Button size="sm" variant="outline" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(null)}>
            Reset to default
          </Button>
        )}
      </div>
    </div>
  );
}

function AppCard({ app }: { app: AppConfig }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(app.name);
  const [repoRoot, setRepoRoot] = useState(app.repoRoot);
  const [checkCommands, setCheckCommands] = useState<CheckCommands>(app.checkCommands);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showCheckCommands, setShowCheckCommands] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const dirty =
    name !== app.name || repoRoot !== app.repoRoot || JSON.stringify(checkCommands) !== JSON.stringify(app.checkCommands);

  const saveMutation = useMutation({
    mutationFn: () => api.updateApp(app.id, { name, repoRoot, checkCommands }),
    onSuccess: (result) => {
      setSaveError(null);
      setSaveNotice(
        result.docsInitialized ? `Created docs/ at ${result.docsDir} — add markdown there for the agents to search.` : null
      );
      queryClient.invalidateQueries({ queryKey: ['apps'] });
    },
    onError: (err) => setSaveError((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteApp(app.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['apps'] }),
    onError: (err) => setSaveError((err as Error).message),
  });

  return (
    <Card
      title={app.name}
      actions={
        <>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/dev-sessions/apps/integrations?appId=${encodeURIComponent(app.id)}`}>
              <Plug />
              Integrations
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/dev-sessions/apps/api-spec?appId=${encodeURIComponent(app.id)}`}>
              <FileCode2 />
              API spec
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <ExternalAnchor href={apiUrl(`/api/apps/${app.id}/docs/handbook`)}>
              <BookOpen />
              Handbook
            </ExternalAnchor>
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FieldRow label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FieldRow>
        <FieldRow label="Repository path">
          <Input value={repoRoot} onChange={(e) => setRepoRoot(e.target.value)} className="font-mono text-xs" />
        </FieldRow>
        <div className="text-xs text-gray-500 pl-[152px]">
          docs: <code>{app.docsDir}</code>
          {app.repoUrl && (
            <>
              {' · '}repo: <code>{app.repoUrl}</code>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="blue" disabled={!dirty || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Disclosure label="Agent prompts" open={showPrompts} onToggle={() => setShowPrompts((v) => !v)} />
          <Disclosure label="Check commands" open={showCheckCommands} onToggle={() => setShowCheckCommands((v) => !v)} />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-gray-500 hover:text-red-600 hover:bg-red-50"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 />
            {deleteMutation.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </div>
        <ErrorText>{saveError}</ErrorText>
        {saveNotice && <Notice tone="green">{saveNotice}</Notice>}

        {showCheckCommands && (
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <p className="text-xs text-gray-500">
              The npm script QA runs at the repo root for each check. Leave blank to use the default script name.
            </p>
            {(Object.keys(DEFAULT_CHECK_COMMANDS) as (keyof CheckCommands)[]).map((key) => (
              <FieldRow key={key} label={key}>
                <Input
                  value={checkCommands[key] ?? ''}
                  onChange={(e) => setCheckCommands((prev) => ({ ...prev, [key]: e.target.value || undefined }))}
                  placeholder={DEFAULT_CHECK_COMMANDS[key]}
                  className="font-mono text-xs"
                />
              </FieldRow>
            ))}
          </div>
        )}
        {showPrompts && (
          <div className="pt-1 border-t border-gray-100">
            {ROLES.map((role) => (
              <PromptRow key={role.key} appId={app.id} role={role.key} label={role.label} />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove ${app.name}?`}
        description="The app is removed from Dev Sessions. Its repository checkout on disk is left untouched."
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => {
          setConfirmingRemove(false);
          deleteMutation.mutate();
        }}
      />
    </Card>
  );
}

export default function AppsPage() {
  const queryClient = useQueryClient();
  const { data: apps, isLoading } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });

  const [name, setName] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [validation, setValidation] = useState<{ ok: boolean; error?: string; note?: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  const validateMutation = useMutation({
    mutationFn: () => api.validateApp(repoRoot),
    onSuccess: (result) => setValidation(result),
  });

  const createMutation = useMutation({
    mutationFn: () => api.createApp({ name, repoRoot }),
    onSuccess: (result) => {
      setName('');
      setRepoRoot('');
      setValidation(null);
      setCreateError(null);
      setCreateNotice(result.docsInitialized ? `Created docs/ at ${result.docsDir} — add markdown there for the agents to search.` : null);
      queryClient.invalidateQueries({ queryKey: ['apps'] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });

  return (
    <PageShell
      title="Apps"
      subtitle="The repositories Dev Sessions can take through requirements → plan → coding → QA. Each session targets one app."
      actions={
        <Button variant="outline" asChild>
          <Link href={SESSIONS_HREF}>
            <ArrowLeft />
            Dev Sessions
          </Link>
        </Button>
      }
    >
      <div className="space-y-4">
        {isLoading && <LoadingState />}
        {!isLoading && apps?.length === 0 && <EmptyState>No apps yet — add one below.</EmptyState>}
        {apps?.map((app) => <AppCard key={app.id} app={app} />)}

        <Card title="Add an app">
          <div className="space-y-3">
            <FieldRow label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Billing" />
            </FieldRow>
            <FieldRow label="Repository path">
              <Input
                value={repoRoot}
                onChange={(e) => {
                  setRepoRoot(e.target.value);
                  setValidation(null);
                }}
                placeholder="/Users/you/acme-billing"
                className="font-mono text-xs"
              />
            </FieldRow>
            <div className="flex gap-2 pl-[152px]">
              <Button size="sm" variant="outline" disabled={!repoRoot.trim() || validateMutation.isPending} onClick={() => validateMutation.mutate()}>
                {validateMutation.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                {validateMutation.isPending ? 'Checking…' : 'Validate'}
              </Button>
              <Button
                size="sm"
                variant="blue"
                disabled={!name.trim() || !repoRoot.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate()}
              >
                <Plus />
                {createMutation.isPending ? 'Adding…' : 'Add app'}
              </Button>
            </div>
            {validation && (
              <Notice tone={validation.ok ? 'green' : 'red'}>
                {validation.ok ? validation.note ?? 'Looks good.' : `Failed: ${validation.error}`}
              </Notice>
            )}
            <ErrorText>{createError}</ErrorText>
            {createNotice && <Notice tone="green">{createNotice}</Notice>}
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
