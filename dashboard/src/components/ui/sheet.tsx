"use client";

import { X } from "lucide-react";
import { useRef } from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

// A panel that slides in from the right edge: title row with a close button, one scrolling body, an optional footer.
// Non-modal: no overlay, the page behind stays live and clickable, so a click on another row swaps the content. Esc closes it.
// On open, focus goes to the title, so a keyboard or screen reader user lands in the panel. The caller returns focus on close.
export function Sheet({ open, onClose, title, description, children, footer }: { open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <SheetPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            heading.current?.focus();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-[-12px_0_32px_-12px_rgb(19_20_22/0.16)] outline-none sm:max-w-[640px] lg:max-w-[min(640px,calc(100vw-608px))]",
            "duration-300 ease-[cubic-bezier(0.2,0,0,1)] data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
          )}
        >
          <header className="flex flex-none items-start gap-4 border-b px-6 py-4">
            <div className="min-w-0 flex-1">
              <SheetPrimitive.Title ref={heading} tabIndex={-1} className="text-base leading-6 font-semibold outline-none">{title}</SheetPrimitive.Title>
              <SheetPrimitive.Description className={description ? "mt-0.5 text-muted-foreground" : "sr-only"}>{description ?? "Details"}</SheetPrimitive.Description>
            </div>
            <SheetPrimitive.Close className="-mt-2.5 -mr-3.5 flex size-11 flex-none sm:-mt-1 sm:-mr-2 sm:size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">Close</span>
            </SheetPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">{children}</div>
          {footer && <footer className="flex flex-none items-center justify-end gap-2 border-t px-6 py-3">{footer}</footer>}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
