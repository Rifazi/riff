'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { THEME_MIGRATION_KICKOFF } from '@/lib/dev-sessions/meeting';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorText, LoadingState } from '../PageShell';

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-foreground">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
      ) : (
        <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
      )}
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Whether the app's code actually uses its theme (the audit the agents'
 * audit_theme tool runs), with a one-click Dev Session to migrate it.
 */
export function ThemeAdoptionCard({ appId, appName, themeName }: { appId: string; appName: string; themeName: string }) {
  const router = useRouter();
  const { data: audit, isLoading, error } = useQuery({
    queryKey: ['theme-audit', appId, themeName],
    queryFn: () => api.getThemeAudit(appId),
  });

  const startMutation = useMutation({
    mutationFn: () =>
      api.createSession({
        title: `Migrate ${appName} to the ${themeName} theme`,
        appId,
      }),
    onSuccess: (session) => router.push(`${sessionHref(session.id, 'requirements')}&kickoff=${THEME_MIGRATION_KICKOFF}`),
  });

  if (isLoading) return <LoadingState label="Checking how the app uses its theme…" />;
  if (error || !audit) return <ErrorText>Couldn&apos;t audit the app: {(error as Error | null)?.message}</ErrorText>;

  const wired = audit.importedFrom.length === 1;
  const done = wired && audit.hardCoded.total === 0 && audit.legacyTokens.length === 0 && audit.tailwind.every((t) => t.usesThemeTokens);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle>Adoption in the app&apos;s code</CardTitle>
        {!done && (
          <Button size="sm" variant="outline" disabled={startMutation.isPending} onClick={() => startMutation.mutate()}>
            <Wand2 />
            {startMutation.isPending ? 'Starting…' : 'Start migration session'}
          </Button>
        )}
      </CardHeader>
      <CardContent>
      <ul className="space-y-1.5">
        <Check ok={wired}>
          {audit.importedFrom.length === 0 ? (
            <>
              <code>theme/index.css</code> isn&apos;t imported anywhere yet.
            </>
          ) : (
            <>
              <code>theme/index.css</code> imported from {audit.importedFrom.map((f) => <code key={f}>{f} </code>)}
              {audit.importedFrom.length > 1 && '(should be once, at the root entry)'}
            </>
          )}
        </Check>
        <Check ok={audit.hardCoded.total === 0}>
          {audit.hardCoded.total} hard-coded color{audit.hardCoded.total === 1 ? '' : 's'} outside <code>theme/</code>
          {audit.hardCoded.total > 0 && (
            <>
              {' '}
              in {audit.hardCoded.byFile.length} files (most in{' '}
              {audit.hardCoded.byFile.slice(0, 3).map((f) => (
                <code key={f.file}>{f.file} </code>
              ))}
              )
            </>
          )}
        </Check>
        <Check ok={audit.legacyTokens.length === 0}>
          {audit.legacyTokens.length === 0 ? (
            'No design tokens of its own outside theme/.'
          ) : (
            <>
              Its own tokens in {audit.legacyTokens.map((t) => <code key={t.file}>{t.file} </code>)}(
              {audit.legacyTokens.reduce((n, t) => n + t.names.length, 0)} variables) to alias onto the theme.
            </>
          )}
        </Check>
        {audit.collisions.length > 0 && (
          <Check ok={false}>
            {audit.collisions.reduce((n, c) => n + c.names.length, 0)} of its tokens reuse the theme&apos;s names (
            {audit.collisions.flatMap((c) => c.names).slice(0, 6).map((n) => <code key={n}>{n} </code>)}…) and would override the
            theme. The migration removes them.
          </Check>
        )}
        {audit.tailwind.map((t) => (
          <Check key={t.file} ok={t.usesThemeTokens}>
            <code>{t.file}</code> {t.usesThemeTokens ? 'maps to the theme tokens.' : "doesn't reference the theme tokens yet."}
          </Check>
        ))}
        {audit.componentLibraries.length > 0 && (
          <Check ok>Uses {audit.componentLibraries.join(', ')}. The migration points their theme config at the tokens.</Check>
        )}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        {done
          ? 'The app is fully on its theme. Changing the theme above restyles everything.'
          : 'A migration session takes this through requirements, plan, coding and QA. The coding agents follow the migration steps in docs/theme.md and re-run this audit to confirm.'}
      </p>
      <ErrorText>{(startMutation.error as Error | null)?.message ?? null}</ErrorText>
      </CardContent>
    </Card>
  );
}
