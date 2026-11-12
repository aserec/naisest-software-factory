"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Action } from "@/server/run-view";
import type { FactoryState } from "@/server/seams";
import { LoadError } from "./shell";
import { useT } from "./use-preferences";

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
const TITLE: Record<Action, string> = { stop: "Stop this run?", resume: "Resume this run?", restart: "Restart this run?", ready: "Set the work item to Ready?" };
const ALL = Object.keys(NAME) as Action[];

function Ask({ action, onConfirm, busy }: { action: Action; onConfirm: () => void; busy: boolean }) {
  const t = useT();
  const name = t(NAME[action]);
  return (
    <Confirm
      trigger={
        <Button variant={action === "stop" ? "destructive" : "outline"} disabled={busy}>
          {name}
        </Button>
      }
      title={t(TITLE[action])}
      description={t(ASK[action])}
      action={name}
      destructive={action === "stop" || action === "restart"}
      onConfirm={onConfirm}
    />
  );
}

// Every action is a button; the ones the run view refuses (server/run-view.ts) are disabled and say why on hover.
export function RunControls({ run }: { run: string }) {
  const t = useT();
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
      if (r.status === 409) throw new Error(t("{name} is already requested.", { name: t(NAME[action]) }));
      if (!r.ok) throw new Error(t("Could not send {name}. {detail}", { name: t(NAME[action]), detail: r.status === 403 ? await r.text() : t("Try again.") }));
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
                    {t(NAME[a])}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("Disabled: {reason}.", { reason: data.refusals[a] ?? t("not allowed now") })}</TooltipContent>
            </Tooltip>
          ),
        )}
      </TooltipProvider>
      {data.pending.map((a) => (
        <span key={a} className="text-muted-foreground">
          {t("{name} requested. The factory picks it up within a minute.", { name: t(NAME[a]) })}
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

// The run page's links out, in the viewer's language. The page renders on the server, so it passes the names it read there.
export function RunLinks({ changeUrl, approving, codeHost, ticketUrl, tracker, boardUrl }: { changeUrl?: string; approving: boolean; codeHost?: string; ticketUrl?: string; tracker?: string; boardUrl?: string }) {
  const t = useT();
  return (
    <>
      {/* Open PR is the main button while the change waits for a person's merge. */}
      {changeUrl && codeHost && (
        <Button asChild variant={approving ? "default" : "outline"}>
          <a href={changeUrl} target="_blank" rel="noreferrer" title={t("Review and merge in {host}", { host: codeHost })}>{t("Open PR")}</a>
        </Button>
      )}
      {tracker && ticketUrl && (
        <Button asChild variant="outline">
          <a href={ticketUrl} target="_blank" rel="noreferrer" title={t("Open the work item in {tracker}", { tracker })}>{t("Open issue")}</a>
        </Button>
      )}
      {boardUrl && (
        <Button asChild variant="outline">
          <a href={boardUrl} target="_blank" rel="noreferrer" title={t("Open the board in {tracker}", { tracker: tracker ?? t("the tracker") })}>{t("Open board")}</a>
        </Button>
      )}
    </>
  );
}

// One text in the viewer's language, for a page that renders on the server.
export const Tr = ({ text, values }: { text: string; values?: Record<string, string | number> }) => useT()(text, values);
