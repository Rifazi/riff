'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/dev-sessions/api';
import {
  PROVIDERS,
  providerNeedsApiKey,
  type Provider,
  type RedactedJiraSettings,
  type Role,
  type RoleModelConfig,
} from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS, COORDINATOR_PERSONA } from '@/lib/dev-sessions/agents';
import { AgentServerBanner } from './AgentServerBanner';
import { ExternalAnchor } from './ExternalAnchor';
import { LoadingState, Pill } from './PageShell';

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude (subscription login)',
  anthropic: 'Anthropic (API key)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
};

const ROLES: { key: Role; label: string; hint: string }[] = [
  { key: 'requirements', label: `${AGENT_PERSONAS.requirements.name} — ${AGENT_PERSONAS.requirements.title}`, hint: 'Requirements' },
  { key: 'plan', label: `${AGENT_PERSONAS.plan.name} — ${AGENT_PERSONAS.plan.title}`, hint: 'Plan' },
  { key: 'coding', label: `${AGENT_PERSONAS.coding.name} — ${AGENT_PERSONAS.coding.title}`, hint: 'Coding' },
  { key: 'qa', label: `${AGENT_PERSONAS.qa.name} — ${AGENT_PERSONAS.qa.title}`, hint: 'QA' },
  { key: 'coordinator', label: `${COORDINATOR_PERSONA.name} — ${COORDINATOR_PERSONA.title}`, hint: 'Opt-in per session' },
];

function Section({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="text-sm text-gray-600 mt-1 mb-4">{description}</p>
      <div className="divide-y divide-gray-100">{children}</div>
    </div>
  );
}

function TestResult({ result, okText }: { result: { ok: boolean; error?: string } | null; okText: string }) {
  if (!result) return null;
  return (
    <div className={`flex items-center gap-1.5 text-sm mt-2 ${result.ok ? 'text-green-700' : 'text-red-600'}`}>
      {result.ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      {result.ok ? okText : `Failed: ${result.error}`}
    </div>
  );
}

function ClaudeLoginRow() {
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const testMutation = useMutation({
    mutationFn: () => api.testCredential({ provider: 'claude' }),
    onSuccess: setTestResult,
  });

  return (
    <div className="py-4 first:pt-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-gray-900">{PROVIDER_LABEL.claude}</div>
          <p className="text-sm text-gray-500 mt-1 max-w-xl">
            Uses whatever <code>claude login</code> set up on this machine — billed against your Claude subscription, not
            an API key. If it isn't logged in, run <code>claude login</code> in a terminal, then test again.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
          {testMutation.isPending && <Loader2 className="animate-spin" />}
          {testMutation.isPending ? 'Testing…' : 'Test'}
        </Button>
      </div>
      <TestResult result={testResult} okText="Connected" />
    </div>
  );
}

function CredentialRow({ provider, hasKey }: { provider: Provider; hasKey: boolean }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const invalidate = () => {
    setTestResult(null);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  };
  const saveMutation = useMutation({
    mutationFn: () => api.updateSettings({ credentials: { [provider]: value } }),
    onSuccess: () => {
      setValue('');
      invalidate();
    },
  });
  const clearMutation = useMutation({
    mutationFn: () => api.updateSettings({ credentials: { [provider]: null } }),
    onSuccess: invalidate,
  });
  const testMutation = useMutation({
    mutationFn: () => api.testCredential({ provider, apiKey: value || undefined }),
    onSuccess: setTestResult,
  });

  return (
    <div className="py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-gray-900">{PROVIDER_LABEL[provider]}</span>
        <Pill tone={hasKey ? 'green' : 'neutral'}>{hasKey ? 'Configured' : 'Not set'}</Pill>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={hasKey ? 'Paste a new key to replace the saved one' : 'Paste API key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <Button size="sm" variant="blue" className="h-9" onClick={() => saveMutation.mutate()} disabled={!value.trim() || saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          onClick={() => testMutation.mutate()}
          disabled={(!value.trim() && !hasKey) || testMutation.isPending}
        >
          {testMutation.isPending ? 'Testing…' : 'Test'}
        </Button>
        {hasKey && (
          <Button size="sm" variant="ghost" className="h-9" onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending}>
            Clear
          </Button>
        )}
      </div>
      <TestResult result={testResult} okText="Key works" />
    </div>
  );
}

function RoleModelRow({
  label,
  hint,
  value,
  knownModels,
  onSave,
  saving,
}: {
  label: string;
  hint: string;
  value: RoleModelConfig;
  knownModels: Record<Provider, string[]>;
  onSave: (config: RoleModelConfig) => void;
  saving: boolean;
}) {
  const [provider, setProvider] = useState(value.provider);
  const [model, setModel] = useState(value.model);

  useEffect(() => {
    setProvider(value.provider);
    setModel(value.model);
  }, [value.provider, value.model]);

  const dirty = provider !== value.provider || model !== value.model;
  const listId = `dev-agent-models-${provider}`;

  return (
    <div className="py-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
      <div>
        <div className="font-medium text-gray-900">{label}</div>
        <div className="text-xs text-gray-500">{hint}</div>
      </div>
      <div className="flex gap-2">
        <Select
          value={provider}
          onValueChange={(next) => {
            setProvider(next as Provider);
            setModel(knownModels[next as Provider]?.[0] ?? '');
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input list={listId} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model ID" className="flex-1 font-mono text-xs" />
        <datalist id={listId}>
          {(knownModels[provider] ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="sm"
          variant="blue"
          className="h-9"
          disabled={!dirty || !model.trim() || saving}
          onClick={() => onSave({ provider, model: model.trim() })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function JiraSettings({ jira }: { jira: RedactedJiraSettings }) {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(jira.baseUrl);
  const [email, setEmail] = useState(jira.email);
  const [issueType, setIssueType] = useState(jira.issueType);
  const [epicLinkFieldId, setEpicLinkFieldId] = useState(jira.epicLinkFieldId);
  const [apiToken, setApiToken] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    setBaseUrl(jira.baseUrl);
    setEmail(jira.email);
    setIssueType(jira.issueType);
    setEpicLinkFieldId(jira.epicLinkFieldId);
  }, [jira.baseUrl, jira.email, jira.issueType, jira.epicLinkFieldId]);

  const fields = { baseUrl, email, issueType: issueType || 'Task', epicLinkFieldId };
  const dirty =
    baseUrl !== jira.baseUrl || email !== jira.email || issueType !== jira.issueType || epicLinkFieldId !== jira.epicLinkFieldId || Boolean(apiToken);

  const saveMutation = useMutation({
    mutationFn: () => api.updateSettings({ jira: { ...fields, apiToken: apiToken || undefined } }),
    onSuccess: () => {
      setApiToken('');
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const testMutation = useMutation({
    mutationFn: () => api.testJiraConnection({ ...fields, apiToken: apiToken || undefined }),
    onSuccess: setTestResult,
  });

  const row = (label: React.ReactNode, input: React.ReactNode) => (
    <div className="py-3 grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2 items-center">
      <div className="text-sm font-medium text-gray-700">{label}</div>
      {input}
    </div>
  );

  return (
    <Section
      title="Jira"
      description="Optional — enables “Create tickets” on the Plan stage: one Jira issue per plan step, linked to the epic your session's ticket belongs to. Jira Cloud only."
    >
      {row('Base URL', <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://yourcompany.atlassian.net" />)}
      {row('Account email', <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />)}
      {row(
        <span className="flex items-center gap-2">
          API token <Pill tone={jira.hasToken ? 'green' : 'neutral'}>{jira.hasToken ? 'Configured' : 'Not set'}</Pill>
        </span>,
        <div>
          <Input
            type="password"
            placeholder={jira.hasToken ? 'Paste a new token to replace the saved one' : 'Paste API token'}
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            autoComplete="off"
          />
          <p className="text-xs text-gray-500 mt-1.5">
            Create one at{' '}
            <ExternalAnchor href="https://id.atlassian.com/manage-profile/security/api-tokens" className="text-blue-600 hover:underline">
              id.atlassian.com/manage-profile/security/api-tokens
            </ExternalAnchor>{' '}
            while signed in as the email above. It's only shown once.
          </p>
        </div>
      )}
      {row('Issue type', <Input value={issueType} onChange={(e) => setIssueType(e.target.value)} placeholder="Task" />)}
      {row(
        'Epic link field ID',
        <Input
          value={epicLinkFieldId}
          onChange={(e) => setEpicLinkFieldId(e.target.value)}
          placeholder="Only for classic (company-managed) projects, e.g. customfield_10014"
        />
      )}
      <div className="pt-4">
        <div className="flex gap-2">
          <Button variant="blue" onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        <TestResult result={testResult} okText="Connected" />
      </div>
    </Section>
  );
}

export function DevAgentSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });

  const saveModelMutation = useMutation({
    mutationFn: (input: { role: Role; config: RoleModelConfig }) => api.updateSettings({ models: { [input.role]: input.config } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  return (
    <div className="space-y-6 mt-6 -mx-8">
      <AgentServerBanner />
      <div className="px-8 space-y-6">
        {isLoading || !settings ? (
          <LoadingState />
        ) : (
          <>
            <Section
              title="Agent providers"
              description="The requirements, plan, coding and QA agents can run on any of these. API keys are stored by the local agent server (harness-server/backend/local-settings.json) and never sent back to this window."
            >
              {PROVIDERS.map((p) =>
                providerNeedsApiKey(p) ? (
                  <CredentialRow key={p} provider={p} hasKey={settings.credentials[p].hasKey} />
                ) : (
                  <ClaudeLoginRow key={p} />
                )
              )}
            </Section>

            <Section
              title="Model per agent"
              description="Each agent can use a different provider and model. Any model ID the provider supports works, not just the suggestions."
            >
              {ROLES.map((role) => (
                <RoleModelRow
                  key={role.key}
                  label={role.label}
                  hint={role.hint}
                  value={settings.models[role.key]}
                  knownModels={settings.knownModels}
                  saving={saveModelMutation.isPending}
                  onSave={(config) => saveModelMutation.mutate({ role: role.key, config })}
                />
              ))}
            </Section>

            <JiraSettings jira={settings.jira} />
          </>
        )}
      </div>
    </div>
  );
}
