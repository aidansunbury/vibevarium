import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon, RadarIcon } from "@terrarium/ui/lib/icons";
import { api, login, logout, type Actor, type AppRow } from "./api";
import { AppDetail } from "./AppDetail";
import { ScaffoldForm } from "./ScaffoldForm";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Dialog } from "@terrarium/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrarium/ui/components/dropdown-menu";
import { Shell, ShellBody, ShellHeader, ShellHeaderActions, ShellHeaderTitle } from "@terrarium/ui/layout/shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@terrarium/ui/components/table";
import { Toaster } from "@terrarium/ui/components/sonner";
import { toast } from "@terrarium/ui/lib/toast";

const statusVariant = (status: AppRow["status"]) =>
  status === "up" ? "success" : status === "down" ? "destructive" : "secondary";

export const App = () => {
  const [actor, setActor] = useState<Actor | null>(null);
  const [authOn, setAuthOn] = useState<boolean | null>(null);
  const [apps, setApps] = useState<Array<AppRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ actor: Actor | null; auth: "on" | "off" }>("/auth/me");
      setActor(me.actor);
      setAuthOn(me.auth === "on");
      const appsBody = await api<{ apps: Array<AppRow> }>("/apps");
      setApps(appsBody.apps);
      setError(null);
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && (cause as { status: number }).status === 401) {
        setActor(null);
        setAuthOn(true);
        setError(null);
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  const runDiscovery = async () => {
    try {
      await api("/discover", { method: "POST", body: "{}" });
      setRefreshTick((n) => n + 1);
      toast.success("Discovery complete");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const signedOut = authOn === true && actor === null;

  return (
    <Shell>
      <ShellHeader>
        <ShellHeaderTitle>
          <span className="font-semibold">Terrarium</span>
          <span className="text-muted-foreground">control plane</span>
        </ShellHeaderTitle>
        <ShellHeaderActions>
          {authOn === false && <Badge variant="secondary">auth off</Badge>}
          {signedOut ? (
            <Button size="sm" onClick={() => login()}>
              Log in
            </Button>
          ) : (
            authOn === true &&
            actor !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted">
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {(actor.name ?? actor.sub).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden sm:inline">{actor.name ?? actor.sub}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span className="text-foreground">{actor.name ?? actor.sub}</span>
                      <span className="text-xs text-muted-foreground">{actor.sub}</span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => void logout()}>Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          )}
        </ShellHeaderActions>
      </ShellHeader>

      <ShellBody>
        {error !== null && (
          <Card className="border-destructive/40 ring-destructive/20">
            <CardContent className="text-destructive">⚠ {error}</CardContent>
          </Card>
        )}

        {signedOut ? (
          <Card>
            <CardHeader>
              <CardTitle>Sign in required</CardTitle>
              <CardDescription>
                This control plane requires sign-in. Use the login button to authenticate with Logto.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => login()}>Log in</Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Registered apps</CardTitle>
                <CardDescription>Apps registered with the gateway, with status and last-seen time.</CardDescription>
                <div className="col-start-2 row-span-2 row-start-1 flex gap-2 self-start justify-self-end">
                  <Button variant="outline" size="sm" onClick={() => setRefreshTick((n) => n + 1)}>
                    <RefreshCwIcon data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void runDiscovery()}>
                    <RadarIcon data-icon="inline-start" />
                    Run discovery
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {apps === null ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps registered. Scaffold one below.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>URL</TableHead>
                        <TableHead>Last seen</TableHead>
                        <TableHead className="w-0" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {apps.map((app) => (
                        <TableRow key={app.name} className="cursor-pointer" onClick={() => setSelected(app.name)}>
                          <TableCell className="font-medium">{app.name}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{app.url}</TableCell>
                          <TableCell className="text-muted-foreground">{app.lastSeenAt ?? "never"}</TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm">
                              details
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
              {selected !== null && (
                <AppDetail
                  name={selected}
                  onDeleted={() => { setSelected(null); setRefreshTick((n) => n + 1); }}
                />
              )}
            </Dialog>

            <ScaffoldForm onScaffolded={() => setRefreshTick((n) => n + 1)} />
            <IntegrationsPanel />
          </>
        )}
      </ShellBody>
      <Toaster />
    </Shell>
  );
};
