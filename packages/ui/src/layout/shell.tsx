import * as React from "react";
import { cn } from "../lib/utils";

/**
 * Base layout shell: a sticky header row plus a content container. The header
 * is `header` + `title` + `actions` slots; the container is centered with a
 * max width and vertical rhythm, and is sidebar-ready (pass `sidebar` to lay
 * out a fixed rail next to the main column).
 */
function Shell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell"
      className={cn("min-h-svh bg-background text-foreground", className)}
      {...props}
    />
  );
}

function ShellHeader({ className, style, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="shell-header"
      className={cn(
        "sticky top-0 z-40 flex h-14 items-center gap-3 border-b-0 bg-background px-4 sm:px-6",
        className,
      )}
      style={{ borderBottom: "var(--rule)", ...style }}
      {...props}
    />
  );
}

function ShellHeaderTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-header-title"
      className={cn("flex min-w-0 items-baseline gap-2 text-sm", className)}
      {...props}
    />
  );
}

function ShellHeaderActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-header-actions"
      className={cn("ml-auto flex items-center gap-2", className)}
      {...props}
    />
  );
}

function ShellBody({
  className,
  sidebar,
  children,
  ...props
}: React.ComponentProps<"div"> & { sidebar?: React.ReactNode }) {
  return (
    <div data-slot="shell-body" className={cn("mx-auto flex w-full max-w-5xl gap-6 px-4 py-6 sm:px-6", className)} {...props}>
      {sidebar !== undefined && sidebar !== null && (
        <aside data-slot="shell-sidebar" className="hidden w-56 shrink-0 md:block">
          {sidebar}
        </aside>
      )}
      <main data-slot="shell-main" className="flex min-w-0 flex-1 flex-col gap-4">
        {children}
      </main>
    </div>
  );
}

export { Shell, ShellHeader, ShellHeaderTitle, ShellHeaderActions, ShellBody };
