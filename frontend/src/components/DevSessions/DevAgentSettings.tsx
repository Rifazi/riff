'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/dev-sessions/api';
import {
  PROVIDERS,
  type Provider,
  type RedactedJiraSettings,
  type SettingsResponse,
  type Role,
  type RoleModelConfig,
} from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS, COORDINATOR_PERSONA } from '@/lib/dev-sessions/agents';
import { Badge } from '@/components/ui/badge';
import { AgentServerBanner } from './AgentServerBanner';
import { ClassificationToolSettings } from './ClassificationToolSettings/ClassificationToolSettings';
import { ExternalAnchor } from './ExternalAnchor';
import { LoadingState } from './PageShell';

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude (subscription login)',
  anthropic: 'Anthropic (API key)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  ollama: 'Ollama (local)',
};

const ROLES: { key: Role; label: string; hint: string }[] = [
  {
    key: 'requirements',
    label: `${AGENT_PERSONAS.requirements.name} — ${AGENT_PERSONAS.requirements.title}`,
    hint: 'Requirements',
  },
  {
    key: 'plan',
    label: `${AGENT_PERSONAS.plan.name} — ${AGENT_PERSONAS.plan.title}`,
    hint: 'Plan',
  },
  {
    key: 'coding',
    label: `${AGENT_PERSONAS.coding.name} — ${AGENT_PERSONAS.coding.title}`,
    hint: 'Coding',
  },
  {
    key: 'qa',
    label: `${AGENT_PERSONAS.qa.name} — ${AGENT_PERSONAS.qa.title}`,
    hint: 'QA',
  },
  {
    key: 'coordinator',
    label: `${COORDINATOR_PERSONA.name} — ${COORDINATOR_PERSONA.title}`,
    hint: 'Opt-in per session',
  },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 mb-4">{description}</p>
      <div className="divide-y divide-border">{children}</div>
    </Card>
  );
}

function TestResult({ result, okText }: { result: { ok: boolean; error?: string } | null; okText: string }) {
  if (!result) return null;
  return (
    <div className={`flex items-center gap-1.5 text-sm mt-2 ${result.ok ? 'text-success' : 'text-destructive'}`}>
      {result.ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      {result.ok ? okText : `Failed: ${result.error}`}
    </div>
  );
}

function ClaudeLoginRow() {
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);
  const testMutation = useMutation({
    mutationFn: () => api.testCredential({ provider: 'claude' }),
    onSuccess: setTestResult,
  });

  return (
    <div className="py-4 first:pt-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-foreground">{PROVIDER_LABEL.claude}</div>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            Uses whatever <code>claude login</code> set up on this machine — billed against your Claude subscription,
            not an API key. If it isn't logged in, run <code>claude login</code> in a terminal, then test again.
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
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);

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
        <span className="font-medium text-foreground">{PROVIDER_LABEL[provider]}</span>
        <Badge variant={hasKey ? 'success' : 'secondary'}>{hasKey ? 'Configured' : 'Not set'}</Badge>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={hasKey ? 'Paste a new key to replace the saved one' : 'Paste API key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <Button
          size="sm"
          className="h-9"
          onClick={() => saveMutation.mutate()}
          disabled={!value.trim() || saveMutation.isPending}
        >
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
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
          >
            Clear
          </Button>
        )}
      </div>
      <TestResult result={testResult} okText="Key works" />
    </div>
  );
}

/**
 * Ollama needs no API key — this row edits the server URL instead. Test
 * checks reachability (via the endpoint typed here, saved or not) and
 * reports what's installed; role pickers suggest those models as the
 * datalist (see DevAgentSettings's ollama-models query).
 */
function OllamaRow({ endpoint }: { endpoint: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(endpoint);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
    models?: { name: string; tools: boolean }[];
  } | null>(null);

  useEffect(() => setValue(endpoint), [endpoint]);

  const trimmed = value.trim();
  const valid = /^https?:\/\/\S+$/.test(trimmed);
  const dirty = trimmed !== endpoint && valid;

  const invalidate = () => {
    setTestResult(null);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    queryClient.invalidateQueries({ queryKey: ['ollama-models'] });
  };
  const saveMutation = useMutation({
    mutationFn: () => api.updateSettings({ ollamaEndpoint: trimmed }),
    onSuccess: invalidate,
  });
  const testMutation = useMutation({
    mutationFn: () => api.testCredential({ provider: 'ollama', endpoint: trimmed || undefined }),
    onSuccess: setTestResult,
  });

  const toolModels = (testResult?.models ?? []).filter((m) => m.tools).length;

  return (
    <div className="py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-foreground">{PROVIDER_LABEL.ollama}</span>
        <Badge variant="success">No key needed</Badge>
      </div>
      <p className="text-sm text-muted-foreground mb-2 max-w-xl">
        Runs any model installed in the system Ollama server (e.g. your bigger Qwen) — tool calling included, nothing
        leaves this machine.
      </p>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://localhost:11434"
          className="flex-1 font-mono text-xs"
          autoComplete="off"
        />
        <Button
          size="sm"
          className="h-9"
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          onClick={() => testMutation.mutate()}
          disabled={!valid || testMutation.isPending}
        >
          {testMutation.isPending ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {testResult &&
        (testResult.ok ? (
          <div className="flex items-center gap-1.5 text-sm mt-2 text-success">
            <CheckCircle2 className="w-4 h-4" />
            {testResult.models?.length
              ? `Connected — ${testResult.models.length} model${testResult.models.length === 1 ? '' : 's'} installed (${toolModels} with tool support)`
              : 'Connected — no models installed yet'}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-sm mt-2 text-destructive">
            <XCircle className="w-4 h-4" />
            Failed: {testResult.error}
          </div>
        ))}
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
        <div className="font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
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
        <Input
          list={listId}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model ID"
          className="flex-1 font-mono text-xs"
        />
        <datalist id={listId}>
          {(knownModels[provider] ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="sm"
          className="h-9"
          disabled={!dirty || !model.trim() || saving}
          onClick={() =>
            // A light model is provider-specific: keep it only while the provider stays the same.
            onSave({
              provider,
              model: model.trim(),
              ...(provider === value.provider && value.lightModel !== undefined
                ? { lightModel: value.lightModel }
                : {}),
              ...(value.useLocalModel !== undefined ? { useLocalModel: value.useLocalModel } : {}),
            })
          }
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
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);

  useEffect(() => {
    setBaseUrl(jira.baseUrl);
    setEmail(jira.email);
    setIssueType(jira.issueType);
    setEpicLinkFieldId(jira.epicLinkFieldId);
  }, [jira.baseUrl, jira.email, jira.issueType, jira.epicLinkFieldId]);

  const fields = {
    baseUrl,
    email,
    issueType: issueType || 'Task',
    epicLinkFieldId,
  };
  const dirty =
    baseUrl !== jira.baseUrl ||
    email !== jira.email ||
    issueType !== jira.issueType ||
    epicLinkFieldId !== jira.epicLinkFieldId ||
    Boolean(apiToken);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateSettings({
        jira: { ...fields, apiToken: apiToken || undefined },
      }),
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
      <div className="text-sm font-medium text-foreground">{label}</div>
      {input}
    </div>
  );

  return (
    <Section
      title="Jira"
      description="Optional — enables “Create tickets” on the Plan stage: one Jira issue per plan step, linked to the epic your session's ticket belongs to. Jira Cloud only."
    >
      {row(
        'Base URL',
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://yourcompany.atlassian.net"
        />,
      )}
      {row(
        'Account email',
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />,
      )}
      {row(
        <span className="flex items-center gap-2">
          API token{' '}
          <Badge variant={jira.hasToken ? 'success' : 'secondary'}>{jira.hasToken ? 'Configured' : 'Not set'}</Badge>
        </span>,
        <div>
          <Input
            type="password"
            placeholder={jira.hasToken ? 'Paste a new token to replace the saved one' : 'Paste API token'}
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            Create one at{' '}
            <ExternalAnchor
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              className="text-primary hover:underline"
            >
              id.atlassian.com/manage-profile/security/api-tokens
            </ExternalAnchor>{' '}
            while signed in as the email above. It's only shown once.
          </p>
        </div>,
      )}
      {row('Issue type', <Input value={issueType} onChange={(e) => setIssueType(e.target.value)} placeholder="Task" />)}
      {row(
        'Epic link field ID',
        <Input
          value={epicLinkFieldId}
          onChange={(e) => setEpicLinkFieldId(e.target.value)}
          placeholder="Only for classic (company-managed) projects, e.g. customfield_10014"
        />,
      )}
      <div className="pt-4">
        <div className="flex gap-2">
          <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
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

/**
 * Coding only: plan steps the plan agent tagged "light" run on this cheaper
 * model; if it errors or doesn't finish the step, the coding model takes
 * over in the same turn.
 */
function LightStepsRow({
  value,
  knownModels,
  defaultLightModel,
  onSave,
  saving,
}: {
  value: RoleModelConfig;
  knownModels: Record<Provider, string[]>;
  defaultLightModel: string;
  onSave: (config: RoleModelConfig) => void;
  saving: boolean;
}) {
  const enabled = value.lightModel !== '' && (value.lightModel !== undefined || defaultLightModel !== '');
  const current = value.lightModel || defaultLightModel;
  const [model, setModel] = useState(current);

  useEffect(() => setModel(current), [current]);

  const dirty = model.trim() !== current;
  const listId = `dev-agent-light-models-${value.provider}`;

  return (
    <div className="py-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
      <div>
        <div className="font-medium text-foreground">Cheaper model for light steps</div>
        <div className="text-xs text-muted-foreground">
          Coding steps the planner marks as mechanical (docs, config, pattern-following) run on this. If it doesn&apos;t
          finish the step, the coding model takes over. QA always reviews on its own model.
        </div>
      </div>
      <div className="flex gap-2 items-center">
        <Switch
          checked={enabled}
          disabled={saving}
          // Providers without a cheaper default (ollama) get the typed model
          // — type one first, then flip the switch to route light steps to it.
          onCheckedChange={(on) => onSave({ ...value, lightModel: on ? defaultLightModel || model.trim() : '' })}
          aria-label="Use a cheaper model for light steps"
        />
        <Input
          list={listId}
          value={enabled ? model : ''}
          // With a default (claude etc.) the input only matters once routing
          // is on; without one there's nothing to enable, so it stays editable.
          disabled={!enabled && defaultLightModel !== ''}
          onChange={(e) => setModel(e.target.value)}
          placeholder={
            enabled || !defaultLightModel ? 'Model ID' : 'Off — every step uses the coding model'
          }
          className="flex-1 font-mono text-xs"
        />
        <datalist id={listId}>
          {(knownModels[value.provider] ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="sm"
          className="h-9"
          disabled={!enabled || !dirty || !model.trim() || saving}
          onClick={() => onSave({ ...value, lightModel: model.trim() })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * Coding only: when enabled, Jack's automatic solo step turns AND every
 * workstream team member run on this Ollama model instead of the cloud
 * coding model — saving cloud tokens on work Jack judges simple enough to
 * spin up locally.
 */
function LocalTeamModelRow({
  value,
  ollamaModels,
  onSave,
  saving,
}: {
  value: RoleModelConfig;
  ollamaModels: string[];
  onSave: (config: RoleModelConfig) => void;
  saving: boolean;
}) {
  const current = value.localTeamModel ?? '';
  const enabled = current !== '';
  const [model, setModel] = useState(current);

  useEffect(() => setModel(current), [current]);

  const dirty = model.trim() !== current;

  return (
    <div className="py-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
      <div>
        <div className="font-medium text-foreground">Local models for team work</div>
        <div className="text-xs text-muted-foreground">
          When Jack decides work can run in parallel he spins up agents on this Ollama model instead of the cloud
          coding model — saving cloud tokens. Also applies to his own solo step turns.
        </div>
      </div>
      <div className="flex gap-2 items-center">
        <Switch
          checked={enabled}
          disabled={saving || (!enabled && !model.trim() && ollamaModels.length === 0)}
          onCheckedChange={(on) => {
            const next = on ? (model.trim() || ollamaModels[0] || '') : '';
            if (next !== current) onSave({ ...value, localTeamModel: next });
            setModel(next);
          }}
          aria-label="Use local Ollama model for team workstreams and solo steps"
        />
        <Input
          list="dev-agent-local-team-models"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={enabled ? 'Ollama model ID' : 'Pick an Ollama model to enable'}
          className="flex-1 font-mono text-xs"
        />
        <datalist id="dev-agent-local-team-models">
          {ollamaModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="sm"
          className="h-9"
          disabled={!enabled || !dirty || !model.trim() || saving}
          onClick={() => onSave({ ...value, localTeamModel: model.trim() })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * Coding only: the Ollama model the delegate tool's read-only helpers run on.
 * The coding agent hands them exploration questions and gets back only the
 * answers, so the files they read never enter its paid context.
 */
function DelegateModelRow({
  value,
  ollamaModels,
  onSave,
  saving,
}: {
  value: RoleModelConfig;
  ollamaModels: string[];
  onSave: (config: RoleModelConfig) => void;
  saving: boolean;
}) {
  const current = value.delegateModel ?? '';
  const enabled = current !== '';
  const [model, setModel] = useState(current);

  useEffect(() => setModel(current), [current]);

  const dirty = model.trim() !== current;

  return (
    <div className="py-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
      <div>
        <div className="font-medium text-foreground">Local helpers for exploration</div>
        <div className="text-xs text-muted-foreground">
          The coding agent hands read-only questions (where is X, who calls Y) to helpers on this Ollama model, which
          read the files for free and return only the answer. Needs a model that can call tools, e.g. qwen3:8b or
          larger. Savings show under Token usage.
        </div>
      </div>
      <div className="flex gap-2 items-center">
        <Switch
          checked={enabled}
          disabled={saving || (!enabled && !model.trim() && ollamaModels.length === 0)}
          onCheckedChange={(on) => {
            const next = on ? (model.trim() || ollamaModels[0] || '') : '';
            if (next !== current) onSave({ ...value, delegateModel: next });
            setModel(next);
          }}
          aria-label="Let the coding agent delegate exploration to local helpers"
        />
        <Input
          list="dev-agent-delegate-models"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={enabled ? 'Ollama model ID' : 'Pick a tool-capable Ollama model to enable'}
          className="flex-1 font-mono text-xs"
        />
        <datalist id="dev-agent-delegate-models">
          {ollamaModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="sm"
          className="h-9"
          disabled={!enabled || !dirty || !model.trim() || saving}
          onClick={() => onSave({ ...value, delegateModel: model.trim() })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** Coordinator only: decide on Riff's built-in local model first, falling back to the coordinator's model. */
function LocalCoordinatorRow({
  value,
  localModel,
  onSave,
  saving,
}: {
  value: RoleModelConfig;
  localModel: SettingsResponse['localModel'];
  onSave: (config: RoleModelConfig) => void;
  saving: boolean;
}) {
  const enabled = value.useLocalModel !== false;
  return (
    <div className="py-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
      <div>
        <div className="font-medium text-foreground">Coordinator on the built-in local model</div>
        <div className="text-xs text-muted-foreground">
          The continue-or-ready decisions run on Riff&apos;s own summary model — free and on this machine. If it&apos;s
          unavailable or gives an unusable answer, the coordinator model above decides instead.
        </div>
      </div>
      <div className="flex gap-3 items-center">
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(on) => onSave({ ...value, useLocalModel: on })}
          aria-label="Run the coordinator on the built-in local model"
        />
        <span className="text-xs text-muted-foreground">
          {localModel.available
            ? `Using ${localModel.model}`
            : `Not available: ${localModel.reason ?? 'unknown reason'} — using ${value.model}.`}
        </span>
      </div>
    </div>
  );
}

export function DevAgentSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });
  // Live model suggestions for the "ollama" provider — whatever is installed
  // on this machine (KNOWN_MODELS can't know that statically).
  const { data: ollamaModels } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: api.listOllamaModels,
    staleTime: 60_000,
  });
  const knownModels = settings
    ? {
        ...settings.knownModels,
        ollama: ollamaModels?.models.map((m) => m.name) ?? settings.knownModels.ollama,
      }
    : undefined;

  const saveModelMutation = useMutation({
    mutationFn: (input: { role: Role; config: RoleModelConfig }) =>
      api.updateSettings({ models: { [input.role]: input.config } }),
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
              description="The requirements, plan, coding and QA agents can run on any of these. API keys are stored by the local agent server (harness-server/backend/local-settings.json) and never sent back to this window — Ollama needs none, it's local."
            >
              {PROVIDERS.map((p) =>
                p === 'claude' ? (
                  <ClaudeLoginRow key={p} />
                ) : p === 'ollama' ? (
                  <OllamaRow key={p} endpoint={settings.ollamaEndpoint} />
                ) : (
                  <CredentialRow key={p} provider={p} hasKey={settings.credentials[p].hasKey} />
                ),
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
                  knownModels={knownModels ?? settings.knownModels}
                  saving={saveModelMutation.isPending}
                  onSave={(config) => saveModelMutation.mutate({ role: role.key, config })}
                />
              ))}
              <LocalCoordinatorRow
                value={settings.models.coordinator}
                localModel={settings.localModel}
                saving={saveModelMutation.isPending}
                onSave={(config) => saveModelMutation.mutate({ role: 'coordinator', config })}
              />
              <LightStepsRow
                value={settings.models.coding}
                knownModels={knownModels ?? settings.knownModels}
                defaultLightModel={settings.defaultLightModels[settings.models.coding.provider]}
                saving={saveModelMutation.isPending}
                onSave={(config) => saveModelMutation.mutate({ role: 'coding', config })}
              />
              <LocalTeamModelRow
                value={settings.models.coding}
                ollamaModels={ollamaModels?.models.map((m) => m.name) ?? []}
                saving={saveModelMutation.isPending}
                onSave={(config) => saveModelMutation.mutate({ role: 'coding', config })}
              />
              <DelegateModelRow
                value={settings.models.coding}
                ollamaModels={ollamaModels?.models.filter((m) => m.tools).map((m) => m.name) ?? []}
                saving={saveModelMutation.isPending}
                onSave={(config) => saveModelMutation.mutate({ role: 'coding', config })}
              />
            </Section>

            <Section
              title="On-device classification"
              description="Agents can offload label-matching subtasks (which of these labels fits this text?) to a small model that runs on this machine instead of a paid cloud model. Weights are cached under harness-server/state/."
            >
              <ClassificationToolSettings settings={settings} />
            </Section>

            <JiraSettings jira={settings.jira} />
          </>
        )}
      </div>
    </div>
  );
}
