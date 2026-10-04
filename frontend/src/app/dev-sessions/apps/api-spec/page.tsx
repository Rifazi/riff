'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { BackButton } from '@/components/BackButton';
import { Card } from '@/components/ui/card';
import { api, apiUrl } from '@/lib/dev-sessions/api';
import { LoadingState, PageShell } from '@/components/DevSessions/PageShell';
import 'swagger-ui-react/swagger-ui.css';

// Swagger UI touches window at import time — client-only.
const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false, loading: () => <LoadingState /> });

function ApiSpecView() {
  const appId = useSearchParams().get('appId');
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });
  const appName = apps?.find((a) => a.id === appId)?.name ?? appId;

  return (
    <PageShell
      title={`${appName ?? 'App'} API spec`}
      subtitle={
        <>
          Read from the app's generated <code>openapi/api.json</code> — try requests against it directly below.
        </>
      }
      back={<BackButton fallbackHref="/dev-sessions/apps" />}
    >
      {appId && (
        <Card className="overflow-hidden">
          <SwaggerUI url={apiUrl(`/api/apps/${appId}/docs/openapi.json`)} />
        </Card>
      )}
    </PageShell>
  );
}

export default function ApiSpecPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ApiSpecView />
    </Suspense>
  );
}
