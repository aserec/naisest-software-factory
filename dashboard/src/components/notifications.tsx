"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { EventOf } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { ago, cn, workItemKey } from "@/lib/utils";
import { type BoardItem, needsYou, newlyWaiting, useBoard } from "./board";
import { STATE } from "@/lib/state";
import { SectionHeading } from "./shell";
import { usePreferences, useT } from "./use-preferences";

type RunEnd = EventOf<"run_end"> & { seq: number };

// How a run ended, in the board's words.
const ENDED: Record<RunEnd["data"]["outcome"], string> = { done: "Done", blocked: "Blocked", needs_info: "Needs info", restarted: "Restarted", closed: "Closed" };

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, v);
    } catch {} // storage blocked: the choice holds for this page only
  },
};

// The highest run_end seq this browser has seen in the panel. Above it counts as unread.
// ponytail: read marks live in this browser only; a per-user table if people want them on every device.
const SEEN_KEY = "notifications.seen";

// The Notify me switch: on when the user saved it on and this browser allows notifications.
// shown is false where the browser has none or the person refused them, so no switch is offered there.
export function useNotifyPref() {
  const { prefs, save } = usePreferences();
  const [perm, setPerm] = useState<NotificationPermission | "none">("none");
  useEffect(() => {
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
  }, []);
  const on = perm === "granted" && !!prefs?.notify;
  const toggle = async () => {
    if (on) return save.mutate({ notify: false });
    const p = await Notification.requestPermission();
    setPerm(p);
    save.mutate({ notify: p === "granted" });
  };
  return { perm, shown: perm !== "none" && perm !== "denied", ready: !!prefs, on, toggle };
}

// Browser notifications, only once a person asks.
function useNotify(data: BoardItem[] | undefined) {
  const t = useT();
  const pref = useNotifyPref();
  const prev = useRef<BoardItem[]>(undefined);
  useEffect(() => {
    if (!data) return;
    if (pref.on && prev.current) for (const body of newlyWaiting(prev.current, data, t)) new Notification(t("Factory"), { body });
    prev.current = data;
  }, [data, pref.on, t]);
  return pref;
}

function useRunEnds() {
  return useQuery({
    queryKey: ["notifications"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await api("/api/notifications");
      if (!r.ok) throw new Error(`Notifications answered ${r.status}`);
      return (await r.json()) as RunEnd[];
    },
  });
}

const card = "flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none hover:border-foreground/20 hover:bg-active/40 focus-visible:ring-2 focus-visible:ring-ring";

// The bell in the top bar. Its count is what waits on a person plus run ends this browser has not seen.
// Its panel lists both, and holds the Notify me switch for browser notifications.
export function Notifications() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data: board } = useBoard();
  const { data: ends = [] } = useRunEnds();
  const notify = useNotify(board);
  const [seen, setSeen] = useState(0);
  // What was unread when the panel opened, so those rows stay marked while it is open.
  const [unreadFrom, setUnreadFrom] = useState(0);
  useEffect(() => setSeen(Number(store.get(SEEN_KEY)) || 0), []);

  const waiting = board ? needsYou(board) : [];
  const unread = ends.filter((e) => e.seq > seen).length;
  const n = waiting.length + unread;
  const titles = new Map(board?.map((i) => [workItemKey(i), i.title]));

  const togglePanel = () => {
    if (!open) {
      setUnreadFrom(seen);
      const top = ends[0]?.seq ?? seen;
      setSeen(top);
      store.set(SEEN_KEY, String(top));
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={n ? t("Notifications, {n} new", { n }) : t("Notifications")}
        onClick={togglePanel}
        className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
        {n > 0 && (
          <span aria-hidden="true" className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-pill-warning-ink/20 bg-pill-warning px-1 text-[10px] leading-none font-semibold text-pill-warning-ink">
            {n > 99 ? "99+" : n}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("Notifications")}
        description={waiting.length ? t("{n} waiting on you", { n: waiting.length }) : t("Nothing waits on you.")}
        footer={
          notify.shown && (
            <Button variant="outline" aria-pressed={notify.on} disabled={!notify.ready} onClick={notify.toggle}>
              {notify.on ? t("Notifying") : t("Notify me")}
            </Button>
          )
        }
      >
        <SectionHeading as="h3">{t("Waiting on you")}</SectionHeading>
        {waiting.length === 0 && <p className="mb-8 text-muted-foreground">{t("Nothing waits on you.")}</p>}
        <ul className="mb-8 flex flex-col gap-2">
          {waiting.map((i) => (
            <li key={workItemKey(i)}>
              <Link href={i.run ? `/runs/${encodeURIComponent(i.run)}` : i.url} onClick={() => setOpen(false)} className={card}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={i.stuck || i.state === "blocked" ? "warning" : "default"}>{t(i.stuck ? "Stuck" : STATE[i.state])}</Badge>
                  <span className="font-medium">{i.title}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">
                    {i.target} #{i.ticket}
                  </span>
                  {ago(i.updatedAt) && ` · ${ago(i.updatedAt)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <SectionHeading as="h3">{t("Run ends")}</SectionHeading>
        {ends.length === 0 && <p className="text-muted-foreground">{t("No run has ended yet.")}</p>}
        <ul className="flex flex-col gap-2">
          {ends.map((e) => {
            const isNew = e.seq > unreadFrom;
            return (
              <li key={e.seq}>
                <Link href={`/runs/${encodeURIComponent(e.run)}`} onClick={() => setOpen(false)} className={cn(card, isNew && "border-foreground/40")}>
                  <span className="flex flex-wrap items-center gap-2">
                    {isNew && <span className="size-2 rounded-full bg-foreground" aria-label={t("Unread")} />}
                    <Badge variant={e.data.outcome === "blocked" ? "warning" : "default"}>{t(ENDED[e.data.outcome])}</Badge>
                    <span className="font-medium">{titles.get(workItemKey(e)) ?? `${e.target} #${e.ticket}`}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <span className="font-mono">
                      {e.target} #{e.ticket}
                    </span>
                    {ago(e.at) && ` · ${ago(e.at)}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}
