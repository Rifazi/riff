'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/dev-sessions/api';

const ADD_NEW = '__add_new_app__';

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

function prettifyName(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Inline "add an app" form: pick a repo folder, confirm the name, done. */
function AddAppForm({ onAdded, onCancel }: { onAdded: (appId: string) => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [repoRoot, setRepoRoot] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const updatePath = (path: string) => {
    setRepoRoot(path);
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

  const createMutation = useMutation({
    mutationFn: async () => {
      const check = await api.validateApp(repoRoot.trim());
      if (!check.ok) throw new Error(check.error ?? 'That folder cannot be used as an app.');
      return api.createApp({ name: name.trim(), repoRoot: repoRoot.trim() });
    },
    onSuccess: async (app) => {
      setNotice(app.docsInitialized ? `Created docs/ in ${app.name} for the agents to search.` : null);
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      onAdded(app.id);
    },
  });

  return (
    <div
      className="rounded-md border border-blue-200 bg-blue-50/50 p-3 space-y-2"
      onKeyDown={(e) => {
        // Can sit inside another form (New session) — Enter adds the app, never submits that.
        if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        if (repoRoot.trim() && name.trim() && !createMutation.isPending) createMutation.mutate();
      }}
    >
      <div className="text-xs font-medium text-gray-700">Add a new app — the repository the agents will work on</div>
      <div className="flex gap-2">
        <Input
          value={repoRoot}
          onChange={(e) => updatePath(e.target.value)}
          placeholder="/Users/you/my-repo"
          className="font-mono text-xs bg-white"
          autoFocus
        />
        <Button type="button" size="sm" variant="outline" className="h-9 bg-white" onClick={browse}>
          <FolderOpen />
          Browse…
        </Button>
      </div>
      <Input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        placeholder="App name"
        className="bg-white"
      />
      {createMutation.isError && <div className="text-xs text-red-600">{(createMutation.error as Error).message}</div>}
      {notice && <div className="text-xs text-green-700">{notice}</div>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="blue"
          disabled={!repoRoot.trim() || !name.trim() || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          {createMutation.isPending ? 'Adding…' : 'Add app'}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={createMutation.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * App selector with an inline "Add new app…" option, so a new repository can
 * be registered right where a session is being started.
 */
export function AppPicker({
  value,
  onChange,
  triggerClassName = '',
  enabled = true,
}: {
  value: string;
  onChange: (appId: string) => void;
  triggerClassName?: string;
  enabled?: boolean;
}) {
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps, enabled });
  const [adding, setAdding] = useState(false);

  // Default to the first app, but never override a choice already made.
  useEffect(() => {
    if (!value && apps && apps.length > 0) onChange(apps[0].id);
  }, [apps, value, onChange]);

  const noApps = apps && apps.length === 0;

  if (noApps || adding) {
    return (
      <div className="w-full basis-full">
        {noApps && <div className="text-xs text-gray-500 mb-2">No apps yet — add the first one.</div>}
        <AddAppForm
          onAdded={(id) => {
            setAdding(false);
            onChange(id);
          }}
          onCancel={noApps ? undefined : () => setAdding(false)}
        />
      </div>
    );
  }

  return (
    <Select
      value={value || undefined}
      onValueChange={(next) => (next === ADD_NEW ? setAdding(true) : onChange(next))}
    >
      <SelectTrigger className={`bg-white ${triggerClassName}`}>
        <SelectValue placeholder={apps ? 'Choose an app' : 'Loading…'} />
      </SelectTrigger>
      <SelectContent>
        {apps?.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
        {apps && apps.length > 0 && <SelectSeparator />}
        <SelectItem value={ADD_NEW} className="text-blue-600">
          ＋ Add new app…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
