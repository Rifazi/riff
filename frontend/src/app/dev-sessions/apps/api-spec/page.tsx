'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
      actions={
        <Button variant="outline" asChild>
          <Link href="/dev-sessions/apps">
            <ArrowLeft />
            Apps
          </Link>
        </Button>
      }
    >
      {appId && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <SwaggerUI url={apiUrl(`/api/apps/${appId}/docs/openapi.json`)} />
        </div>
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
