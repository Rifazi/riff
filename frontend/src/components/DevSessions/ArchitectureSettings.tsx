'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FilePlus2, ListChecks, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/dev-sessions/api';
import type { ArchitectureAudit, ArchitectureConfig } from '@/lib/dev-sessions/types';
import { ErrorText, Notice } from './PageShell';
import { ExternalAnchor } from './ExternalAnchor';
import { SetupNotices, toSetupReport, type SetupReport } from './SetupNotices';

export const WAYFINDING_REPO_URL = 'https://github.com/Rifazi/wayfinding-architecture';
export const DEFAULT_WAYFINDING: ArchitectureConfig = { kind: 'wayfinding', srcDirs: ['src'], interfaceFile: 'service.ts' };

export function architectureLabel(architecture: ArchitectureConfig | null): string {
  return architecture ? 'Wayfinding' : 'none';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <Label className="text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** Pick an architecture for an app, and where its domains live. */
export function ArchitectureFields({
  value,
  onChange,
}: {
  value: ArchitectureConfig | null;
  onChange: (next: ArchitectureConfig | null) => void;
}) {
  return (
    <div className="space-y-3">
      <Row label="Architecture">
        <Select value={value ? value.kind : 'none'} onValueChange={(kind) => onChange(kind === 'none' ? null : value ?? DEFAULT_WAYFINDING)}>
          <SelectTrigger aria-label="Architecture">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="wayfinding">Wayfinding Architecture</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {value && (
        <>
          <p className="text-xs text-muted-foreground pl-[152px]">
            Every important decision is owned by exactly one domain.{' '}
            <ExternalAnchor href={WAYFINDING_REPO_URL} className="text-primary hover:underline">
              Wayfinding
            </ExternalAnchor>{' '}
            keeps a <code>MAP.md</code> of domains and a <code>DOMAIN.md</code> in each. The agents read them first, plan changes as
            segments one domain at a time, keep the docs current, and run the architecture checks. QA reviews the code and docs together.
            Saving creates <code>MAP.md</code> and <code>docs/wayfinding.md</code> on the base branch if they&apos;re missing. Domains are
            added as changes need them.
          </p>
          <SrcDirsField value={value.srcDirs} onChange={(srcDirs) => onChange({ ...value, srcDirs })} />
          <Row label="Interface file">
            <Input
              value={value.interfaceFile}
              onChange={(e) => onChange({ ...value, interfaceFile: e.target.value })}
              placeholder={DEFAULT_WAYFINDING.interfaceFile}
              className="font-mono text-xs"
            />
          </Row>
          <p className="text-xs text-muted-foreground pl-[152px]">
            The one file in each domain that other domains may import. Matched by name, so <code>service.ts</code> also covers{' '}
            <code>service.js</code>.
          </p>
        </>
      )}
    </div>
  );
}

/** The folders domains live under: one per package in a repo with several (e.g. server/src and client/src). */
function SrcDirsField({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const dirs = value.length ? value : [''];
  const set = (i: number, dir: string) => onChange(dirs.map((d, j) => (j === i ? dir : d)));
  return (
    <>
      {dirs.map((dir, i) => (
        <Row key={i} label={i === 0 ? 'Domain folders' : ''}>
          <div className="flex gap-2">
            <Input
              value={dir}
              onChange={(e) => set(i, e.target.value)}
              placeholder={DEFAULT_WAYFINDING.srcDirs[0]}
              aria-label={`Domain folder ${i + 1}`}
              className="font-mono text-xs"
            />
            {dirs.length > 1 && (
              <Button size="icon" variant="ghost" aria-label={`Remove ${dir || 'folder'}`} onClick={() => onChange(dirs.filter((_, j) => j !== i))}>
                <X />
              </Button>
            )}
          </div>
        </Row>
      ))}
      <div className="pl-[152px] space-y-1">
        <Button size="sm" variant="outline" onClick={() => onChange([...dirs, ''])}>
          <Plus />
          Add folder
        </Button>
        <p className="text-xs text-muted-foreground">
          Every folder that holds domains, e.g. <code>server/src</code> and <code>client/src</code> in a repo with two packages.
          Code outside them gets no map, so agents have to search for it.
        </p>
      </div>
    </>
  );
}

/**
 * Run the checks the agents run, or create the starting files, for a saved app.
 * `onChangeSrcDirs` updates the (unsaved) domain folders with one the checks found.
 */
export function ArchitectureTools({
  appId,
  srcDirs,
  onChangeSrcDirs,
}: {
  appId: string;
  srcDirs: string[];
  onChangeSrcDirs: (next: string[]) => void;
}) {
  const [audit, setAudit] = useState<ArchitectureAudit | null>(null);
  const [setupReport, setSetupReport] = useState<SetupReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const auditMutation = useMutation({
    mutationFn: () => api.getArchitectureAudit(appId),
    onSuccess: (result) => {
      setError(null);
      setAudit(result);
    },
    onError: (err) => setError((err as Error).message),
  });
  const setupMutation = useMutation({
    mutationFn: () => api.setupArchitecture(appId),
    onSuccess: (result) => {
      setError(null);
      setSetupReport(toSetupReport([], result));
    },
    onError: (err) => setError((err as Error).message),
  });

  const problems = audit?.audit.problems.length ?? 0;
  const candidates = audit?.audit.srcDirCandidates ?? [];
  const missing = audit?.audit.missingSrcDirs ?? [];
  // A found folder replaces the configured ones that don't exist.
  const useDir = (dir: string) => onChangeSrcDirs([...srcDirs.filter((d) => !missing.includes(d)), dir]);
  return (
    <div className="space-y-2 pl-[152px]">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={auditMutation.isPending} onClick={() => auditMutation.mutate()}>
          {auditMutation.isPending ? <Loader2 className="animate-spin" /> : <ListChecks />}
          {auditMutation.isPending ? 'Checking…' : 'Run checks'}
        </Button>
        <Button size="sm" variant="outline" disabled={setupMutation.isPending} onClick={() => setupMutation.mutate()}>
          {setupMutation.isPending ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
          Set up files
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      <SetupNotices report={setupReport} />
      {audit && (
        <>
          {candidates.length > 0 && (
            <Notice tone="amber">
              <span>
                {missing.length ? `${missing.map((d) => `${d}/`).join(', ')} doesn't exist. ` : ''}
                There are domains outside the domain folders, under{' '}
              </span>
              {candidates.map((dir) => (
                <Button key={dir} size="sm" variant="outline" className="ml-1" onClick={() => useDir(dir)}>
                  Add {dir}/
                </Button>
              ))}
            </Notice>
          )}
          <Notice tone={problems ? 'amber' : 'green'}>
            {audit.audit.domains.length} domain(s) · {problems ? `${problems} problem(s)` : 'no problems'}
            {audit.audit.undocumented?.length
              ? ` · ${audit.audit.undocumented.length} folder(s) of code without a DOMAIN.md (agents add one when they change them)`
              : ''}
          </Notice>
          <pre className="max-h-80 overflow-auto custom-scrollbar text-xs bg-muted border border-border rounded-md p-3 whitespace-pre-wrap">
            {audit.report}
          </pre>
        </>
      )}
    </div>
  );
}
