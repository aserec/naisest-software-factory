import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { EventType } from "software-factory/run-events";
import type { SeqEvent } from "./run-timeline";

export const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
export const renderWithQuery = (ui: ReactElement) => render(ui, { wrapper });

export const json = (body: unknown) => new Response(JSON.stringify(body));

let seq = 0;
// Fixtures may hold only part of an event's data, so `data` is loose here and the result is cast to the event of that type.
export const ev = <T extends EventType>(type: T, at: string, rest: Partial<Omit<SeqEvent, "type" | "data">> & { data?: Record<string, unknown> } = {}) => ({
  seq: ++seq,
  id: `e${seq}`,
  run: "r1",
  at: `2026-10-29T10:${at}:00Z`,
  target: "t",
  ticket: "7",
  type,
  data: {},
  ...rest,
}) as Extract<SeqEvent, { type: T }>;

// GET /api/preferences answers this user with these preferences. A PUT is kept, recorded in `puts`, and answers 204.
export function servePreferences(prefs: Record<string, unknown> = {}) {
  const puts: unknown[] = [];
  const me = { user: { username: "ann", signIn: "Forge" }, prefs: { theme: "system", notify: false, insightsRange: "7d", ...prefs } };
  const handle = (init?: RequestInit) => {
    if (init?.method !== "PUT") return json(me);
    const change = JSON.parse(String(init.body)) as Record<string, unknown>;
    puts.push(change);
    Object.assign(me.prefs, change);
    return new Response(null, { status: 204 });
  };
  return { puts, handle };
}
