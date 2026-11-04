"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";

type Action = "stop" | "resume" | "restart";
interface RunState {
  label?: string;
  cancelled: boolean;
  restarted: boolean;
  pending: Action[];
}

const ASK: Record<Action, string> = {
  stop: "The running step ends. If it does not stop within a minute, the factory cancels the pipeline.",
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

// Stop while the last state label is factory_running. Resume and Restart while it is factory_stopped.
// After a pipeline cancel only Restart, because the cancelled job saved nothing to resume from (spec 6.1).
export function RunControls({ run }: { run: string }) {
  const client = useQueryClient();
  const key = ["run-state", run];
  const { data, error } = useQuery({
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
      if (!r.ok) throw new Error(await r.text());
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  // Without a state there is nothing safe to offer, so say why the buttons are missing.
  if (!data && error)
    return (
      <p role="alert" className="text-destructive">
        Could not read the run state ({error.message}). Stop and Resume show once it loads.
      </p>
    );
  if (!data) return null;
  // A cancel means the run is over even before the poller sets the stopped label, so only Restart is left (Ruling R18).
  // A done restart ended the run: a new run carries on, so this one shows no buttons.
  const buttons: Action[] = data.pending.length || data.restarted ? [] : data.cancelled ? ["restart"] : data.label === "factory_running" ? ["stop"] : data.label === "factory_stopped" ? ["resume", "restart"] : [];
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {buttons.map((a) => (
        <Ask key={a} action={a} busy={send.isPending} onConfirm={() => send.mutate(a)} />
      ))}
      {buttons.length === 0 && data.pending.length === 0 && !data.restarted && (
        <p className="text-muted-foreground">
          {data.label ? (
            <>
              The state label is <code className="font-mono text-xs">{data.label}</code>, so there is nothing to stop or resume.
            </>
          ) : (
            "The work item has no state label, so there is nothing to stop or resume."
          )}
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
