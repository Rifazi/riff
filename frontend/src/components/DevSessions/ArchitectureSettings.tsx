'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FilePlus2, ListChecks, Loader2 } from 'lucide-react';
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
export const DEFAULT_WAYFINDING: ArchitectureConfig = { kind: 'wayfinding', srcDir: 'src', interfaceFile: 'service.ts' };

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
          <Row label="Domains folder">
            <Input
              value={value.srcDir}
              onChange={(e) => onChange({ ...value, srcDir: e.target.value })}
              placeholder={DEFAULT_WAYFINDING.srcDir}
              className="font-mono text-xs"
            />
          </Row>
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

/**
 * Run the checks the agents run, or create the starting files, for a saved app.
 * `onUseSrcDir` switches the (unsaved) source folder to one the checks found.
 */
export function ArchitectureTools({ appId, onUseSrcDir }: { appId: string; onUseSrcDir: (srcDir: string) => void }) {
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
  const candidates = audit && !audit.audit.srcDirExists ? (audit.audit.srcDirCandidates ?? []) : [];
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
              <span>The source folder doesn&apos;t exist, but there are domains under </span>
              {candidates.map((dir) => (
                <Button key={dir} size="sm" variant="outline" className="ml-1" onClick={() => onUseSrcDir(dir)}>
                  Use {dir}/
                </Button>
              ))}
            </Notice>
          )}
          <Notice tone={problems ? 'amber' : 'green'}>
            {audit.audit.domains.length} domain(s) · {problems ? `${problems} problem(s)` : 'no problems'}
          </Notice>
          <pre className="max-h-80 overflow-auto custom-scrollbar text-xs bg-muted border border-border rounded-md p-3 whitespace-pre-wrap">
            {audit.report}
          </pre>
        </>
      )}
    </div>
  );
}
