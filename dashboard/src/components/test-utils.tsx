import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { SeqEvent } from "./run-timeline";

export const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
export const renderWithQuery = (ui: ReactElement) => render(ui, { wrapper });

export const json = (body: unknown) => new Response(JSON.stringify(body));

let seq = 0;
export const ev = (type: SeqEvent["type"], at: string, rest: Partial<SeqEvent> = {}): SeqEvent => ({
  seq: ++seq,
  id: `e${seq}`,
  run: "r1",
  at: `2026-10-29T10:${at}:00Z`,
  target: "t",
  ticket: "7",
  type,
  data: {},
  ...rest,
});
