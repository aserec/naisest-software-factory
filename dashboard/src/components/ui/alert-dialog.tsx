"use client";

import { useRef } from "react";
import { AlertDialog as Primitive } from "radix-ui";
import { buttonVariants } from "@/components/ui/button";

// A yes-or-no confirm. Focus starts on Cancel, so Enter never fires the action by accident.
// With a trigger it opens itself; without one, open and onOpenChange drive it (a trigger would overwrite its child's data-state).
export function Confirm({ trigger, open, onOpenChange, title, description, action, destructive, onConfirm }: { trigger?: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; title: string; description: string; action: string; destructive?: boolean; onConfirm: () => void }) {
  // Without a trigger, Radix cannot give focus back on close, so keep the element that had it when the dialog opened.
  // Read during render: Radix moves focus to Cancel in an effect, after this.
  const back = useRef<HTMLElement | null>(null);
  if (!trigger && open && !back.current && typeof document !== "undefined") back.current = document.activeElement as HTMLElement | null;
  const restore = (e: Event) => {
    if (trigger || !back.current) return;
    e.preventDefault();
    back.current.focus();
    back.current = null;
  };
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>}
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-foreground/20 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Primitive.Content onCloseAutoFocus={restore} className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-6 shadow-[0_12px_32px_-8px_rgb(var(--shadow-ink)/0.2)] outline-none duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none">
          <Primitive.Title className="text-base leading-6 font-semibold">{title}</Primitive.Title>
          <Primitive.Description className="mt-2 text-muted-foreground">{description}</Primitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Primitive.Cancel className={buttonVariants({ variant: "outline" })}>Cancel</Primitive.Cancel>
            <Primitive.Action className={buttonVariants({ variant: destructive ? "destructive" : "default" })} onClick={onConfirm}>
              {action}
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
