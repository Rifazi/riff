'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { IntegrationDoc } from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { Card, EmptyState, LoadingState, PageShell } from '@/components/DevSessions/PageShell';
import { MarkdownDocument } from '@/components/DevSessions/MarkdownDocument';

function IntegrationsView() {
  const appId = useSearchParams().get('appId');
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });
  const appName = apps?.find((a) => a.id === appId)?.name ?? appId;

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations', appId],
    queryFn: () => api.listIntegrations(appId!),
    enabled: Boolean(appId),
  });

  const [selectedDoc, setSelectedDoc] = useState<IntegrationDoc | null>(null);
  const { data: docContent, isLoading: isLoadingDoc } = useQuery({
    queryKey: ['integration-doc', appId, selectedDoc?.file],
    queryFn: () => api.getIntegrationDoc(appId!, selectedDoc!.file),
    enabled: Boolean(appId) && Boolean(selectedDoc),
  });

  return (
    <PageShell
      title={`${appName ?? 'App'} integrations`}
      subtitle={
        <>
          Partner integrations documented under <code>docs/transmission/</code> in this app's repo. When{' '}
          {AGENT_PERSONAS.coding.name} documents a new one there, it shows up here automatically.
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
      {isLoading && <LoadingState />}
      {!isLoading && integrations?.length === 0 && <EmptyState>No documented integrations found under docs/transmission/.</EmptyState>}
      {integrations && integrations.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start">
          <div className="space-y-3">
            {integrations.map((integration) => (
              <Card key={integration.slug} title={integration.title}>
                <p className="text-sm text-gray-600 mb-3">{integration.summary}</p>
                <div className="flex flex-wrap gap-1.5">
                  {[{ file: integration.readmePath, title: 'Overview' }, ...integration.docs].map((doc) => (
                    <Button
                      key={doc.file}
                      size="sm"
                      variant={selectedDoc?.file === doc.file ? 'blue' : 'outline'}
                      onClick={() =>
                        setSelectedDoc(doc.file === integration.readmePath ? { file: doc.file, title: `${integration.title} overview` } : doc)
                      }
                    >
                      {doc.title}
                    </Button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
          <Card title={selectedDoc ? selectedDoc.title : 'Document'} className="lg:sticky lg:top-0">
            {!selectedDoc && <div className="py-8 text-center text-sm text-gray-500">Pick a document on the left.</div>}
            {selectedDoc && isLoadingDoc && <LoadingState />}
            {selectedDoc && docContent && <MarkdownDocument markdown={docContent.markdown} />}
          </Card>
        </div>
      )}
    </PageShell>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <IntegrationsView />
    </Suspense>
  );
}
