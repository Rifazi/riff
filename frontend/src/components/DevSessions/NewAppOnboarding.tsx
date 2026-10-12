'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, ArrowRight, Check, FolderOpen, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/dev-sessions/api';
import type { AppWriteResult, ArchitectureConfig, ThemeDraft } from '@/lib/dev-sessions/types';
import { ErrorText, Notice } from './PageShell';
import { SetupNotices, appSetupReport, type SetupReport } from './SetupNotices';
import { ThemeStudio } from './themes/ThemeStudio';
import { ArchitectureFields, architectureLabel } from './ArchitectureSettings';

const STEPS = ['Repository', 'Theme', 'Architecture', 'Review'] as const;
type Step = (typeof STEPS)[number];

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  );
}

function prettifyName(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function StepChips({ current }: { current: Step }) {
  const index = STEPS.indexOf(current);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((step, i) => (
        <li
          key={step}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
            i === index
              ? 'border-primary bg-primary/10 text-primary font-medium'
              : i < index
                ? 'border-border text-foreground'
                : 'border-border text-muted-foreground'
          }`}
        >
          {i < index ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
          {step}
        </li>
      ))}
    </ol>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * Adding an app, step by step: the repository, then the optional theme and
 * architecture, then one createApp call that sets all of it up. Shared by
 * the Apps page and the "Add new app…" choice wherever a session starts.
 */
export function NewAppOnboarding({ onDone, onCancel }: { onDone: (app: AppWriteResult) => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('Repository');
  const [repoRoot, setRepoRoot] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [themeDraft, setThemeDraft] = useState<ThemeDraft | null>(null);
  const [architecture, setArchitecture] = useState<ArchitectureConfig | null>(null);
  const [created, setCreated] = useState<{ app: AppWriteResult; report: SetupReport } | null>(null);

  const updatePath = (path: string) => {
    setRepoRoot(path);
    setSetupNote(null);
    if (!nameTouched) setName(prettifyName(folderName(path)));
  };

  const browse = async () => {
    try {
      const picked = await invoke<string | null>('pick_app_repo_folder');
      if (picked) updatePath(picked);
    } catch {
      // Picker unavailable (e.g. plain browser dev) — the path field still works.
    }
  };

  const validateMutation = useMutation({
    mutationFn: () => api.validateApp(repoRoot.trim()),
    onSuccess: (check) => {
      if (!check.ok) return;
      setSetupNote(check.note ?? null);
      setStep('Theme');
    },
  });
  const validationError = validateMutation.data && !validateMutation.data.ok ? validateMutation.data.error : null;

  const createMutation = useMutation({
    mutationFn: () => api.createApp({ name: name.trim(), repoRoot: repoRoot.trim(), architecture, ...(themeDraft ?? {}) }),
    onSuccess: async (app) => {
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      const report = appSetupReport(app);
      if (report) setCreated({ app, report });
      else onDone(app);
    },
  });

  if (created) {
    return (
      <div className="space-y-3">
        <Notice tone="green">
          <span className="font-medium">{created.app.name}</span> is ready for Dev Sessions.
        </Notice>
        <SetupNotices report={created.report} />
        <Button size="sm" onClick={() => onDone(created.app)}>
          <Check />
          Done
        </Button>
      </div>
    );
  }

  const canContinue = Boolean(repoRoot.trim() && name.trim());
  const back = () => setStep(STEPS[STEPS.indexOf(step) - 1]);
  const next = () => setStep(STEPS[STEPS.indexOf(step) + 1]);

  return (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        // Can sit inside another form (New session) — Enter moves on here, never submits that.
        if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        if (step === 'Repository' && canContinue && !validateMutation.isPending) validateMutation.mutate();
      }}
    >
      <StepChips current={step} />

      {step === 'Repository' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The repository the agents will work on: an existing checkout, an empty folder, or a new folder to create. A folder that
            isn&apos;t a git repo yet gets <code>git init</code>, a starter <code>.gitignore</code> and an initial commit; a missing{' '}
            <code>docs/</code> is created.
          </p>
          <div className="space-y-1.5">
            <Label>Repository path</Label>
            <div className="flex gap-2">
              <Input
                value={repoRoot}
                onChange={(e) => updatePath(e.target.value)}
                placeholder="/Users/you/my-repo"
                className="font-mono text-xs"
                autoFocus
              />
              <Button type="button" size="sm" variant="outline" className="h-9" onClick={browse}>
                <FolderOpen />
                Browse…
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="e.g. Acme Billing"
            />
          </div>
          <ErrorText>{validationError ?? (validateMutation.isError ? (validateMutation.error as Error).message : null)}</ErrorText>
        </div>
      )}

      {step === 'Theme' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optional. Pick the look the agents build every view from, or skip it and choose one later on the app&apos;s Theme page.
          </p>
          <ThemeStudio value={themeDraft} onChange={setThemeDraft} appName={name.trim() || undefined} allowNone />
        </div>
      )}

      {step === 'Architecture' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optional. How the agents organize and change the code. You can change this later under the app&apos;s Architecture settings.
          </p>
          <ArchitectureFields value={architecture} onChange={setArchitecture} />
        </div>
      )}

      {step === 'Review' && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <ReviewRow label="Name">{name.trim()}</ReviewRow>
          <ReviewRow label="Repository">
            <code className="text-xs">{repoRoot.trim()}</code>
            {setupNote && <span className="block text-xs text-muted-foreground mt-0.5">{setupNote}</span>}
          </ReviewRow>
          <ReviewRow label="Theme">{themeDraft ? themeDraft.theme.name : 'none'}</ReviewRow>
          <ReviewRow label="Architecture">
            {architecture ? (
              <>
                {architectureLabel(architecture)} · domains under <code className="text-xs">{architecture.srcDir}/</code>, interface{' '}
                <code className="text-xs">{architecture.interfaceFile}</code>
              </>
            ) : (
              'none'
            )}
          </ReviewRow>
          <ErrorText>{createMutation.isError ? (createMutation.error as Error).message : null}</ErrorText>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {step !== 'Repository' && (
          <Button type="button" size="sm" variant="ghost" onClick={back} disabled={createMutation.isPending}>
            <ArrowLeft />
            Back
          </Button>
        )}
        {step === 'Repository' && (
          <Button type="button" size="sm" disabled={!canContinue || validateMutation.isPending} onClick={() => validateMutation.mutate()}>
            {validateMutation.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            {validateMutation.isPending ? 'Checking…' : 'Next'}
          </Button>
        )}
        {(step === 'Theme' || step === 'Architecture') && (
          <Button type="button" size="sm" onClick={next}>
            <ArrowRight />
            Next
          </Button>
        )}
        {step === 'Review' && (
          <Button type="button" size="sm" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {createMutation.isPending ? 'Adding…' : 'Add app'}
          </Button>
        )}
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onCancel} disabled={createMutation.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
