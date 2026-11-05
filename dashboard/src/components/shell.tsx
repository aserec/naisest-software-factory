"use client";

import { LayoutList, LogOut, Menu, Server, ToggleRight } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Board", icon: LayoutList },
  { href: "/runner", label: "Runner", icon: Server },
  { href: "/switches", label: "Switches", icon: ToggleRight },
];

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

function crumbs(path: string): { label: string; href?: string }[] {
  // The run id is already under the page title in mono; repeating it here reads as "Run run-…".
  if (path.startsWith("/runs/")) return [{ label: "Board", href: "/" }, { label: "Run" }];
  return [{ label: NAV.find((n) => n.href === path)?.label ?? "Factory" }];
}

function Nav({ path }: { path: string }) {
  return (
    <nav aria-label="Main" className="isolate flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" || path.startsWith("/runs/") : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-foreground/80 hover:bg-active/60 hover:text-foreground active:scale-[0.98] aria-[current=page]:text-foreground"
          >
            {active && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-lg bg-active" />}
            <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
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

type Theme = "system" | "light" | "dark";

// System, Light or Dark. The choice is data-theme on <html> and "theme" in localStorage; layout.tsx applies it before first paint.
export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const pick = (t: Theme) => {
    setTheme(t);
    const html = document.documentElement;
    if (t === "system") html.removeAttribute("data-theme");
    else html.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch {
      // Storage blocked: the choice holds for this page only.
    }
  };
  return (
    <select
      aria-label="Theme"
      value={theme}
      onChange={(e) => pick(e.target.value as Theme)}
      className="ml-auto h-9 rounded-lg bg-transparent px-2 text-sm text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}

// Tinted L-frame (sidebar and top bar on one ground, no rule between) around a white sheet inset 8px right and bottom.
// On a phone the frame folds into a 48px bar with a menu.
// signOut is a server action; layout.tsx passes it so this file does not load next-auth.
export function Shell({ children, signOut }: { children: React.ReactNode; signOut: () => Promise<void> }) {
  const path = usePathname() ?? "/";
  if (path === "/sign-in") return <>{children}</>;
  const trail = crumbs(path);
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[228px_minmax(0,1fr)] md:grid-rows-[48px_1fr]">
      <aside className="hidden px-3 md:row-span-2 md:block">
        <div className="flex h-12 items-center px-2.5">
          <Brand />
        </div>
        <div className="mt-4">
          <Nav path={path} />
        </div>
      </aside>

      <header className="flex h-12 items-center gap-3 px-4 md:pr-6 md:pl-[25px]">
        <details key={path} className="md:hidden" onKeyDown={(e) => e.key === "Escape" && e.currentTarget.removeAttribute("open")}>
          <summary aria-label="Menu" className="flex size-11 cursor-pointer list-none items-center justify-center rounded-md hover:bg-active [&::-webkit-details-marker]:hidden">
            <Menu className="size-5" strokeWidth={1.5} />
          </summary>
          <div className="fixed inset-x-0 top-12 bottom-0 z-40 bg-ground px-3 pt-2">
            <Nav path={path} />
          </div>
        </details>
        <span className="md:hidden">
          <Mark />
        </span>
        <ol className="flex min-w-0 items-center gap-2 text-sm">
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
        <ThemeSelect />
        <form action={signOut}>
          <button type="submit" className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-active hover:text-foreground">
            <LogOut className="size-4" strokeWidth={1.5} aria-hidden="true" />
            Sign out
          </button>
        </form>
      </header>

      <div className="min-h-[calc(100dvh-48px)] min-w-0 bg-background px-4 pt-4 pb-10 md:mr-2 md:mb-2 md:min-h-0 md:rounded-xl md:border md:px-6 md:pt-6">
        <motion.div key={path} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          {children}
        </motion.div>
      </div>
    </div>
  );
}
