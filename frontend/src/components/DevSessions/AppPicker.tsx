'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/dev-sessions/api';
import { NewAppOnboarding } from './NewAppOnboarding';

const ADD_NEW = '__add_new_app__';

/**
 * App selector with an "Add new app…" option that opens the new-app
 * onboarding, so a repository can be registered and set up right where a
 * session is being started.
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
  const { data: apps } = useQuery({
    queryKey: ['apps'],
    queryFn: api.listApps,
    enabled,
  });
  const [adding, setAdding] = useState(false);

  // Default to the first app, but never override a choice already made.
  useEffect(() => {
    if (!value && apps && apps.length > 0) onChange(apps[0].id);
  }, [apps, value, onChange]);

  const noApps = apps && apps.length === 0;

  const onboarding = (
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto custom-scrollbar">
        <DialogHeader>
          <DialogTitle>Add an app</DialogTitle>
          <DialogDescription>Set up the repository the agents will work on. Only the repository is required.</DialogDescription>
        </DialogHeader>
        <NewAppOnboarding
          onDone={(app) => {
            setAdding(false);
            onChange(app.id);
          }}
          onCancel={() => setAdding(false)}
        />
      </DialogContent>
    </Dialog>
  );

  if (noApps) {
    return (
      <div className="w-full basis-full flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
        <span className="text-sm text-muted-foreground">No apps yet. Add the repository the agents will work on.</span>
        <Button type="button" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add your first app
        </Button>
        {onboarding}
      </div>
    );
  }

  return (
    <>
      <Select value={value || undefined} onValueChange={(next) => (next === ADD_NEW ? setAdding(true) : onChange(next))}>
        <SelectTrigger className={`bg-card ${triggerClassName}`}>
          <SelectValue placeholder={apps ? 'Choose an app' : 'Loading…'} />
        </SelectTrigger>
        <SelectContent>
          {apps?.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
          {apps && apps.length > 0 && <SelectSeparator />}
          <SelectItem value={ADD_NEW} className="text-primary">
            ＋ Add new app…
          </SelectItem>
        </SelectContent>
      </Select>
      {onboarding}
    </>
  );
}
