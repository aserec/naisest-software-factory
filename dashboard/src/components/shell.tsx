"use client";

import { ChartColumn, ChevronDown, CircleUser, Inbox, LayoutList, LogOut, Menu, MessageSquare, Server, Settings, SlidersHorizontal, ToggleRight } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { AgentChat, useChatOpen } from "./agent-chat";
import { needsYou, useBoard } from "./board";
import { Notifications } from "./notifications";
import { UsageLimits } from "./usage-limits";
import { usePreferences } from "./use-preferences";

const PAGES = [
  { href: "/insights", label: "Insights", icon: ChartColumn },
  { href: "/runner", label: "Runner", icon: Server },
  { href: "/switches", label: "Switches", icon: ToggleRight },
  { href: "/dispatches", label: "Dispatches", icon: Inbox },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
];

type NavItem = (typeof PAGES)[number];

// The factory's mark: three stations on one line, the last one lit.
export function Mark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 text-data" aria-hidden="true">
      <path d="M3 10h14" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="7.5" width="5" height="5" rx="1" fill="var(--ground)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="var(--ground)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

// The run page sets its target here, since a run's URL does not name the target.
const RunTargetContext = createContext<(target: string | undefined) => void>(() => {});

export function RunTarget({ target }: { target?: string }) {
  const set = useContext(RunTargetContext);
  useEffect(() => {
    set(target);
    return () => set(undefined);
  }, [set, target]);
  return null;
}

function crumbs(path: string, runTarget?: string): { label: string; href?: string }[] {
  // The run id's first 8 characters, as git shortens a hash; the full id is under the page title.
  if (path.startsWith("/runs/")) {
    const run = { label: `Run ${decodeURIComponent(path.slice(6)).slice(0, 8)}` };
    const board = { label: "Board", href: "/" };
    return runTarget ? [board, { label: runTarget, href: `/boards/${encodeURIComponent(runTarget)}` }, run] : [board, run];
  }
  if (path === "/preferences") return [{ label: "Preferences" }];
  if (path.startsWith("/boards/")) return [{ label: "Board", href: "/" }, { label: decodeURIComponent(path.slice(8)) }];
  if (path === "/") return [{ label: "Board" }];
  return [{ label: PAGES.find((n) => n.href === path)?.label ?? "Factory" }];
}

const navLink = "relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-foreground/80 hover:bg-active/60 hover:text-foreground active:scale-[0.98] aria-[current=page]:text-foreground";

function NavLink({ href, active, icon: Icon, children, className }: { href: string; active: boolean; icon?: NavItem["icon"]; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn(navLink, className)}>
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-lg bg-active" />}
      {Icon && <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />}
      {children}
    </Link>
  );
}

// Board opens the overview of every target; each target's own board sits under it as a child, on a tree line.
function Nav({ path, boards }: { path: string; boards: string[] }) {
  const on = (href: string) => path === href || path.startsWith(`${href}/`);
  // The same board query the bell reads, so the counts cost no extra fetch.
  const { data } = useBoard();
  const waiting = Array.isArray(data) ? needsYou(data) : [];
  return (
    <nav aria-label="Main" className="isolate flex flex-col gap-0.5">
      <NavLink href="/" active={path === "/" || path.startsWith("/runs/")} icon={LayoutList}>
        Board
      </NavLink>
      {boards.length > 0 && (
        <ul className="ml-[17px] flex flex-col gap-0.5 border-l border-border pl-2">
          {boards.map((b) => {
            const href = `/boards/${encodeURIComponent(b)}`;
            const mine = Array.isArray(data) ? data.filter((i) => i.target === b && !i.closed && !waiting.includes(i)) : [];
            // Waiting on you (yellow), then running (green), then ready (blue). A zero badge stays grey so only live counts take a colour.
            const counts = [
              [waiting.filter((i) => i.target === b).length, "waiting on you", "bg-pill-warning text-pill-warning-ink"],
              [mine.filter((i) => i.state === "running").length, "running", "bg-pill-positive text-pill-positive-ink"],
              [mine.filter((i) => i.state === "ready").length, "ready", "bg-pill-info text-pill-info-ink"],
            ] as const;
            return (
              <li key={b} className="relative before:absolute before:top-3.5 before:-left-2 before:w-1.5 before:border-t before:border-border">
                {/* Two rows: the board's name, then its counts, so a long name never squeezes the badges. */}
                <NavLink href={href} active={on(href)} className="h-auto flex-col items-start gap-1.5 py-1.5 font-mono text-xs">
                  <span className="max-w-full truncate">{b}</span>
                  <span className="flex gap-1">
                    {counts.map(([n, label, tone]) => (
                      <span key={label} title={`${n} ${label}`} className={cn("min-w-5 rounded-full px-1.5 text-center tabular-nums", n ? tone : "bg-active text-muted-foreground")}>
                        {n}
                        <span className="sr-only"> {label}</span>
                      </span>
                    ))}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
      {PAGES.map((p) => (
        <NavLink key={p.href} href={p.href} active={on(p.href)} icon={p.icon}>
          {p.label}
        </NavLink>
      ))}
    </nav>
  );
}

const Brand = () => (
  <Link href="/" className="flex items-center gap-2 font-semibold hover:opacity-80">
    <Mark />
    Factory
  </Link>
);

// Every screen opens with this row: the h1, one grey line about the data, and the screen's actions on the right.
export function PageTitle({ title, children, actions }: { title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-8 font-semibold">{title}</h1>
        {children && <p className="mt-1 text-muted-foreground">{children}</p>}
      </div>
      {actions}
    </div>
  );
}

// A load that failed: what failed in plain words, the time of the data still on screen, and Retry.
// The server's status stays out; the server logs it.
export function LoadError({ what, query, className = "" }: { what: string; query: { dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown }; className?: string }) {
  const asOf = query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined;
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-destructive", className)}>
      <p>
        Could not load {what}.{asOf && ` Showing it as of ${asOf}.`}
      </p>
      <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>
        Retry
      </Button>
    </div>
  );
}

// The one section heading: a title on a 1px rule, 8px above the rule and 12px below it. h2 on a page, h3 inside a panel.
export function SectionHeading({ as: Tag = "h2", children, className = "" }: { as?: "h2" | "h3"; children: React.ReactNode; className?: string }) {
  return <Tag className={cn("mb-3 flex items-baseline gap-2 border-b pb-2 font-semibold", Tag === "h2" ? "text-base" : "text-sm", className)}>{children}</Tag>;
}

// The theme choices in the order the preferences page lists them.
export const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

// data-theme on <html>, and "theme" in localStorage so layout.tsx can apply it before first paint on the next load.
function applyTheme(t: Theme) {
  const html = document.documentElement;
  if (t === "system") html.removeAttribute("data-theme");
  else html.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", t);
  } catch {
    // Storage blocked: the saved preference still applies once it loads.
  }
}

// Puts the saved theme on <html> once preferences load and whenever the preferences page changes it.
// Until then, the theme layout.tsx applied from localStorage stays.
export function ThemeSync() {
  const saved = usePreferences().prefs?.theme;
  useEffect(() => {
    if (saved) applyTheme(saved);
  }, [saved]);
  return null;
}

const menuItem = "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-active";

// The account button at the end of the top bar: who is signed in, Preferences, and Sign out.
export function UserMenu({ signOut }: { signOut: () => Promise<void> }) {
  const { me } = usePreferences();
  const [leaving, start] = useTransition();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-active data-[state=open]:text-foreground">
        <CircleUser className="size-4" strokeWidth={1.5} aria-hidden="true" />
        <span className="max-w-32 truncate max-sm:sr-only">{me?.user.username ?? "Account"}</span>
        <ChevronDown className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-lg border bg-background p-1 text-sm">
          {me && (
            <>
              <DropdownMenu.Label className="px-2.5 py-2">
                <span className="block truncate font-medium">{me.user.username}</span>
                <span className="block text-xs text-muted-foreground">Signed in with {me.user.signIn}</span>
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
            </>
          )}
          <DropdownMenu.Item asChild className={menuItem}>
            <Link href="/preferences">
              <Settings className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
              Preferences
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
          <DropdownMenu.Item className={menuItem} disabled={leaving} onSelect={() => start(() => signOut())}>
            <LogOut className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
            {leaving ? "Signing out…" : "Sign out"}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// Tinted L-frame (sidebar and top bar on one ground, no rule between) around a white sheet inset 8px right and bottom.
// From md up the frame stays put and only the sheet scrolls. The sheet is relative so absolute children (sr-only text) scroll with it instead of growing the window.
// On a phone the frame folds into a 48px bar with a menu.
// signOut is a server action; layout.tsx passes it so this file does not load next-auth.
export function Shell({ children, signOut, boards = [] }: { children: React.ReactNode; signOut: () => Promise<void>; boards?: string[] }) {
  const path = usePathname() ?? "/";
  const [runTarget, setRunTarget] = useState<string>();
  const [chatOpen, toggleChat] = useChatOpen();
  if (path === "/sign-in") return <>{children}</>;
  const trail = crumbs(path, runTarget);
  return (
    <div className="min-h-dvh md:grid md:h-dvh md:grid-cols-[228px_minmax(0,1fr)_auto] md:grid-rows-[48px_minmax(0,1fr)] md:overflow-hidden">
      <aside className="hidden px-3 md:row-span-2 md:block md:overflow-y-auto">
        <div className="flex h-12 items-center px-2.5">
          <Brand />
        </div>
        <div className="mt-4">
          <Nav path={path} boards={boards} />
        </div>
      </aside>

      <header className="flex h-12 items-center gap-3 px-4 md:col-span-2 md:pr-6 md:pl-[25px]">
        <details key={path} className="md:hidden" onKeyDown={(e) => e.key === "Escape" && e.currentTarget.removeAttribute("open")}>
          <summary aria-label="Menu" className="flex size-11 cursor-pointer list-none items-center justify-center rounded-md hover:bg-active [&::-webkit-details-marker]:hidden">
            <Menu className="size-5" strokeWidth={1.5} />
          </summary>
          <div className="fixed inset-x-0 top-12 bottom-0 z-40 bg-ground px-3 pt-2">
            <Nav path={path} boards={boards} />
          </div>
        </details>
        <span className="md:hidden">
          <Mark />
        </span>
        <ol aria-label="Breadcrumb" className="mr-auto flex min-w-0 items-center gap-2 text-sm">
          {trail.map((c, i) => (
            <li key={c.label} className="flex min-w-0 items-center gap-2">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {c.href ? (
                <Link href={c.href} className="text-muted-foreground hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="truncate font-medium">{c.label}</span>
              )}
            </li>
          ))}
        </ol>
        <ThemeSync />
        <button
          type="button"
          aria-pressed={chatOpen}
          onClick={toggleChat}
          className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-active aria-pressed:text-foreground"
        >
          <MessageSquare className="size-4" strokeWidth={1.5} aria-hidden="true" />
          <span className="max-sm:sr-only">Chat</span>
        </button>
        <UsageLimits />
        <Notifications />
        <UserMenu signOut={signOut} />
      </header>

      <div data-sheet className="relative min-h-[calc(100dvh-48px)] min-w-0 bg-background px-4 pt-4 pb-10 md:mr-2 md:mb-2 md:min-h-0 md:overflow-y-auto md:rounded-xl md:border md:px-6 md:pt-6">
        <RunTargetContext.Provider value={setRunTarget}>
          <motion.div key={path} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            {children}
          </motion.div>
        </RunTargetContext.Provider>
      </div>
      {chatOpen && <AgentChat path={path} />}
    </div>
  );
}
