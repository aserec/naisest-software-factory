"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentPlan } from "software-factory/run-events";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/server/db";

const OPEN_KEY = "agent-chat-open";

// Whether the panel is open: a per-viewer preference kept in localStorage. It starts closed and reads the saved choice after mount, so the server and client render the same first paint.
export function useChatOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      // Storage blocked: the panel starts closed.
    }
  }, []);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Storage blocked: the choice holds until the page reloads.
    }
  };
  return [open, toggle];
}

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Plan({ plan, onGo, going, error }: { plan: AgentPlan; onGo: () => void; going: boolean; error?: string }) {
  return (
    <div className="mt-2 rounded-lg border bg-raised p-3">
      <p className="font-medium">{plan.summary}</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        {plan.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        {plan.repo}
        {plan.target && ` · ${plan.target}`} · {plan.state}
      </p>
      {plan.approvedBy && <p className="mt-1 text-xs text-muted-foreground">Approved by {plan.approvedBy}</p>}
      {plan.state === "done" && plan.result && (/^https?:\/\//.test(plan.result) ? (
        <a href={plan.result} className="mt-1 block truncate text-data underline-offset-4 hover:underline">
          {plan.result}
        </a>
      ) : (
        <p className="mt-1">{plan.result}</p>
      ))}
      {plan.state === "proposed" && (
        <Button className="mt-3" onClick={onGo} disabled={going}>
          Go
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// One chat per page path, shared by everyone who opens that page. The agent answers from the screen's data and may propose a plan; Go approves it.
export function AgentChat({ path }: { path: string }) {
  const client = useQueryClient();
  const key = ["chat", path];
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const chat = useQuery({
    queryKey: key,
    refetchInterval: 5000,
    queryFn: async () => {
      const r = await api(`/api/chat?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`Chat answered ${r.status}`);
      return ((await r.json()) as { messages: ChatMessage[] }).messages;
    },
  });
  const send = useMutation({
    mutationFn: async (t: string) => {
      const r = await api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, text: t }) });
      // A 502 still carries the messages, with the model's failure as the last one.
      if (r.ok || r.status === 502) client.setQueryData(key, ((await r.json()) as { messages: ChatMessage[] }).messages);
      else throw new Error((await r.text()) || `Sending answered ${r.status}`);
    },
    onSuccess: () => setText(""),
  });
  const go = useMutation({
    mutationFn: async (id: string) => {
      const r = await api(`/api/chat/plans/${encodeURIComponent(id)}`, { method: "POST" });
      if (!r.ok) throw new Error((await r.text()) || `Approving answered ${r.status}`);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const messages = chat.data ?? [];
  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight });
  }, [messages.length, send.isPending]);

  return (
    <aside aria-label="Agent chat" className="fixed inset-x-0 top-12 bottom-0 z-30 flex flex-col bg-background text-sm md:static md:z-auto md:mr-2 md:mb-2 md:min-h-0 md:w-[22rem] md:rounded-xl md:border">
      <div ref={list} role="log" aria-live="polite" aria-label="Messages" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {chat.isError && <p role="alert" className="text-destructive">Could not load the chat.</p>}
        {!chat.isError && !chat.isPending && messages.length === 0 && <p className="text-muted-foreground">Ask about this page. The agent answers from what the page shows.</p>}
        {messages.map((m) => (
          <div key={m.seq}>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{m.author}</span> · {time(m.at)}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap">{m.text}</p>
            {m.plan && <Plan plan={m.plan} going={go.isPending} onGo={() => go.mutate(m.plan!.id)} error={go.variables === m.plan.id ? go.error?.message : undefined} />}
          </div>
        ))}
        {send.isPending && <p className="text-muted-foreground">Thinking...</p>}
      </div>
      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate(text.trim());
        }}
      >
        {send.isError && (
          <p role="alert" className="mb-2 text-destructive">
            {send.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <input
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={send.isPending}
            maxLength={4000}
            placeholder="Ask the agent"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={send.isPending || !text.trim()}>
            <Send strokeWidth={1.5} aria-hidden="true" />
          </Button>
        </div>
      </form>
    </aside>
  );
}
