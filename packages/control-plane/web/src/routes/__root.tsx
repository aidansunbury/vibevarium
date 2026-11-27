import { useState } from "react";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { loadSession, type Session } from "../session";
import { login, logout } from "../api";
import { CliInstallDialog, McpConnectDialog } from "../components/setup-dialogs";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vibevarium/ui/components/dropdown-menu";
import { Shell, ShellBody, ShellHeader, ShellHeaderActions, ShellHeaderTitle } from "@vibevarium/ui/layout/shell";
import { LogoLockup } from "@vibevarium/ui/components/logo";
import { Toaster } from "@vibevarium/ui/components/sonner";
import {
  LayoutGridIcon,
  LinkIcon,
  PlugIcon,
  PlusIcon,
  ShieldIcon,
  TerminalIcon,
} from "@vibevarium/ui/lib/icons";

export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async (): Promise<{ session: Session }> => ({ session: await loadSession() }),
  component: RootLayout,
});

export const useSession = (): Session => Route.useRouteContext().session;

const NAV = [
  { to: "/", label: "Apps", icon: LayoutGridIcon },
  { to: "/scaffold", label: "Provision", icon: PlusIcon },
  { to: "/connections", label: "Connections", icon: LinkIcon },
] as const;

function RootLayout() {
  const session = useSession();
  const actor = session.actor;
  const [setupDialog, setSetupDialog] = useState<"cli" | "mcp" | null>(null);

  // No unauthed state: an empty session bounces straight to the auth server
  // (the full-page /auth/login redirect). Rendering during the bounce is a
  // blank redirecting state — never a sign-in card with a button to click.
  if (session.authOn && actor === null) {
    login();
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Redirecting to sign in…
      </div>
    );
  }

  return (
    <Shell>
      <ShellHeader>
        <ShellHeaderTitle>
          <LogoLockup />
          <span className="text-muted-foreground">control plane</span>
        </ShellHeaderTitle>
        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
          {session.isSuperadmin && (
            <Link
              to="/admin"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              <ShieldIcon className="size-4" />
              Admin
            </Link>
          )}
        </nav>
        <ShellHeaderActions>
          {!session.authOn && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSetupDialog("cli")}>
                <TerminalIcon data-icon="inline-start" />
                Install CLI
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSetupDialog("mcp")}>
                <PlugIcon data-icon="inline-start" />
                Connect MCP
              </Button>
              <Badge variant="secondary">auth off</Badge>
            </>
          )}
          {session.authOn && actor !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted">
                <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                  {(actor.name ?? actor.sub).slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:inline">{actor.name ?? actor.sub}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span className="text-foreground">{actor.name ?? actor.sub}</span>
                      <span className="text-xs text-muted-foreground">{actor.sub}</span>
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setSetupDialog("cli")}>
                  <TerminalIcon className="size-4" />
                  Install CLI
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSetupDialog("mcp")}>
                  <PlugIcon className="size-4" />
                  Connect MCP
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void logout()}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ShellHeaderActions>
      </ShellHeader>

      <ShellBody>
        <Outlet />
      </ShellBody>
      <CliInstallDialog open={setupDialog === "cli"} onOpenChange={(open) => !open && setSetupDialog(null)} />
      <McpConnectDialog open={setupDialog === "mcp"} onOpenChange={(open) => !open && setSetupDialog(null)} />
      <Toaster />
    </Shell>
  );
}
