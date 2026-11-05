"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import type { Action } from "@/server/run-view";
import type { FactoryState } from "@/server/seams";
import { STATE } from "./board";
import { LoadError } from "./shell";

interface RunState {
  state?: FactoryState;
  actions: Action[]; // the buttons, from the run view on the server
  restarted: boolean;
  pending: Action[];
}

const ASK: Record<Action, string> = {
  stop: "The running step ends. If it does not stop within a minute, the factory cancels its CI run.",
  resume: "The run continues at the stopped step with its saved record and session.",
  restart: "The run ends as blocked and a new run starts from the beginning.",
};

function Ask({ action, onConfirm, busy }: { action: Action; onConfirm: () => void; busy: boolean }) {
  const name = action[0].toUpperCase() + action.slice(1);
  return (
    <Confirm
      trigger={
        <Button variant={action === "stop" ? "destructive" : "outline"} disabled={busy}>
          {name}
        </Button>
      }
      title={`${name} this run?`}
      description={ASK[action]}
      action={name}
      destructive={action !== "resume"}
      onConfirm={onConfirm}
    />
  );
}

// The buttons are the actions the run view allows (server/run-view.ts); this component only shows them.
export function RunControls({ run }: { run: string }) {
  const client = useQueryClient();
  const key = ["run-state", run];
  const runState = useQuery({
    queryKey: key,
    refetchInterval: 3000,
    queryFn: async () => {
      const r = await api(`/api/runs/${encodeURIComponent(run)}/state`);
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as RunState;
    },
  });
  const send = useMutation({
    mutationFn: async (action: Action) => {
      const r = await api(`/api/runs/${encodeURIComponent(run)}/${action}`, { method: "POST" });
      // 409: the same request already waits. 403: the server's sentence says which role is missing.
      if (r.status === 409) throw new Error(`${action[0].toUpperCase() + action.slice(1)} is already requested.`);
      if (!r.ok) throw new Error(`Could not send ${action}. ${r.status === 403 ? await r.text() : "Try again."}`);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  // Without a state there is nothing safe to offer, so say why the buttons are missing.
  const { data, error } = runState;
  if (!data && error) return <LoadError what="the run state, so Stop and Resume are hidden" query={runState} />;
  if (!data) return null;
  const { state: current, actions: buttons } = data;
  // A run that waits for approval says so on the page; the person's action is the merge, not a control.
  const quiet = current === "needs_approval";
  // Nothing to show: no wrapper either, or the title row's gap leaves a hole after the merge button.
  if (quiet && !buttons.length && !data.pending.length && !send.error) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {buttons.map((a) => (
        <Ask key={a} action={a} busy={send.isPending} onConfirm={() => send.mutate(a)} />
      ))}
      {buttons.length === 0 && data.pending.length === 0 && !data.restarted && !quiet && (
        <p className="text-muted-foreground">
          {current ? `The work item is ${STATE[current]}, so there is nothing to stop or resume.` : "The work item has no state, so there is nothing to stop or resume."}
        </p>
      )}
      {data.pending.map((a) => (
        <span key={a} className="text-muted-foreground">
          {a[0].toUpperCase() + a.slice(1)} requested. The factory picks it up within a minute.
        </span>
      ))}
      {send.error && (
        <p role="alert" className="text-destructive">
          {send.error.message}
        </p>
      )}
    </div>
  );
}
