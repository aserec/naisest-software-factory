"use client";

import { LayoutList, Menu, Server, ToggleRight } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
  if (path.startsWith("/runs/")) return [{ label: "Board", href: "/" }, { label: `Run ${decodeURIComponent(path.slice(6))}` }];
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
        <h1 className="text-[22px] leading-7 font-semibold">{title}</h1>
        {children && <p className="mt-1 text-muted-foreground">{children}</p>}
      </div>
      {actions}
    </div>
  );
}

// Tinted L-frame (sidebar and top bar on one ground, no rule between) around a white sheet inset 8px right and bottom.
// On a phone the frame folds into a 48px bar with a menu.
export function Shell({ children }: { children: React.ReactNode }) {
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

      <header className="flex h-12 items-center gap-3 px-4 md:px-6">
        <details key={path} className="md:hidden">
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
      </header>

      <div className="min-h-[calc(100dvh-48px)] min-w-0 bg-background px-4 pt-5 pb-10 md:mr-2 md:mb-2 md:min-h-0 md:rounded-xl md:border md:px-6 md:pt-6">
        <motion.div key={path} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          {children}
        </motion.div>
      </div>
    </div>
  );
}
