"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Action } from "@/server/run-view";
import type { FactoryState } from "@/server/seams";
import { LoadError } from "./shell";

interface RunState {
  state?: FactoryState;
  actions: Action[]; // the buttons, from the run view on the server
  restarted: boolean;
  pending: Action[];
  refusals: Partial<Record<Action, string>>; // why each action that is not in `actions` is refused
}

const ASK: Record<Action, string> = {
  stop: "The running step ends. If it does not stop within a minute, the factory cancels its CI run.",
  resume: "The run continues at the stopped step with its saved record and session.",
  restart: "The run ends as blocked and a new run starts from the beginning.",
  ready: "The factory sets the work item to Ready in your name. A blocked run continues where it stopped.",
};
const NAME: Record<Action, string> = { stop: "Stop", resume: "Resume", restart: "Restart", ready: "Set to Ready" };
const ALL = Object.keys(NAME) as Action[];
const why = (refusal = "not allowed now") => `Disabled: ${refusal}.`;

function Ask({ action, onConfirm, busy }: { action: Action; onConfirm: () => void; busy: boolean }) {
  const name = NAME[action];
  return (
    <Confirm
      trigger={
        <Button variant={action === "stop" ? "destructive" : "outline"} disabled={busy}>
          {name}
        </Button>
      }
      title={action === "ready" ? "Set the work item to Ready?" : `${name} this run?`}
      description={ASK[action]}
      action={name}
      destructive={action === "stop" || action === "restart"}
      onConfirm={onConfirm}
    />
  );
}

// Every action is a button; the ones the run view refuses (server/run-view.ts) are disabled and say why on hover.
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
      if (r.status === 409) throw new Error(`${NAME[action]} is already requested.`);
      if (!r.ok) throw new Error(`Could not send ${NAME[action]}. ${r.status === 403 ? await r.text() : "Try again."}`);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  // Without a state there is nothing safe to offer, so say why the buttons are missing.
  const { data, error } = runState;
  if (!data && error) return <LoadError what="the run state, so the run buttons are hidden" query={runState} />;
  if (!data) return null;
  return (
    <div className="contents">
      <TooltipProvider>
        {ALL.map((a) =>
          data.actions.includes(a) ? (
            <Ask key={a} action={a} busy={send.isPending} onConfirm={() => send.mutate(a)} />
          ) : (
            <Tooltip key={a}>
              {/* A disabled button gets no pointer events, so the span carries the hover and the focus. */}
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button variant="outline" disabled>
                    {NAME[a]}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{why(data.refusals[a])}</TooltipContent>
            </Tooltip>
          ),
        )}
      </TooltipProvider>
      {data.pending.map((a) => (
        <span key={a} className="text-muted-foreground">
          {NAME[a]} requested. The factory picks it up within a minute.
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
