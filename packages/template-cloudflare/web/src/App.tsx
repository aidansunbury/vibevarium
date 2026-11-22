import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type AuthStatus, type TicketSummary, type WhoAmI } from "./client";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Input } from "@terrarium/ui/components/input";
import { Label } from "@terrarium/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@terrarium/ui/components/table";
import { Shell, ShellBody, ShellHeader, ShellHeaderActions, ShellHeaderTitle } from "@terrarium/ui/layout/shell";
import { Toaster } from "@terrarium/ui/components/sonner";
import { toast } from "@terrarium/ui/lib/toast";

type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message}${typeof error.body === "string" ? `: ${error.body}` : ""}`
    : error instanceof Error
      ? error.message
      : String(error);

export const App = () => {
  const [tickets, setTickets] = useState<LoadState<readonly TicketSummary[]>>({ status: "loading" });
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setTickets({ status: "loading" });
    try {
      const list = await api.listTickets();
      setTickets({ status: "ready", value: list.tickets });
    } catch (error) {
      setTickets({ status: "error", message: errorMessage(error) });
    }
  }, []);

  const refreshWhoami = useCallback(async () => {
    try {
      setWhoami(await api.whoami());
    } catch {
      setWhoami(null);
    }
  }, []);

  useEffect(() => {
    api.authStatus().then(setAuthStatus, () => setAuthStatus({ enabled: false }));
    void refresh();
    void refreshWhoami();
  }, [refresh, refreshWhoami]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await refresh();
        await refreshWhoami();
      } catch (error) {
        setActionError(errorMessage(error));
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshWhoami],
  );

  const onOpenTicket = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const title = field("title");
    const reporter = field("reporter");
    if (title.length === 0 || reporter.length === 0) return;
    event.currentTarget.reset();
    void runAction(async () => {
      const receipt = await api.openTicket({ title, reporter });
      // Read the list back at the command's version: read-your-write, no sleep.
      const list = await api.listTicketsAtLeast(receipt);
      setTickets({ status: "ready", value: list.tickets });
      toast.success(`Opened “${title}”`);
    });
  };

  const onCloseTicket = (id: string) =>
    void runAction(async () => {
      const receipt = await api.closeTicket(id);
      const list = await api.listTicketsAtLeast(receipt);
      setTickets({ status: "ready", value: list.tickets });
      toast.success(`Closed ${id}`);
    });

  const onDevLogin = () =>
    void runAction(async () => {
      if (authStatus?.issuer === undefined) {
        throw new Error("The worker did not report an issuer");
      }
      await api.devLogin(authStatus.issuer, {
        sub: "user-ada",
        name: "Ada",
        audience: `${window.location.hostname}.terrarium.local`,
      });
    });

  const onLogout = () =>
    void runAction(async () => {
      setToken(null);
    });

  const loggedIn = getToken() !== null;

  return (
    <Shell>
      <ShellHeader>
        <ShellHeaderTitle>
          <span className="font-semibold">Tickets</span>
          <span className="text-muted-foreground">a Terrarium app</span>
        </ShellHeaderTitle>
        <ShellHeaderActions>
          {authStatus !== null && !authStatus.enabled && <Badge variant="secondary">auth off</Badge>}
          {authStatus?.enabled === true && (
            loggedIn ? (
              <div className="flex items-center gap-2">
                {whoami?.actor != null && (
                  <span className="hidden text-sm text-muted-foreground sm:inline">
                    {whoami.actor.name !== undefined ? whoami.actor.name : whoami.actor.sub}
                  </span>
                )}
                <Button variant="outline" size="sm" disabled={busy} onClick={onLogout}>
                  Log out
                </Button>
              </div>
            ) : (
              <Button size="sm" disabled={busy} onClick={onDevLogin}>
                Log in (dev)
              </Button>
            )
          )}
        </ShellHeaderActions>
      </ShellHeader>

      <ShellBody className="max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>
              {authStatus === null
                ? "Checking auth…"
                : authStatus.enabled
                  ? loggedIn
                    ? `Signed in${whoami?.actor?.name !== undefined ? ` as ${whoami.actor.name}` : ""}${whoami?.actor != null ? ` (${whoami.actor.sub})` : ""}`
                    : "Sign in to call the API with your identity."
                  : "Auth is off (no TERRARIUM_ISSUER configured)."}
            </CardDescription>
          </CardHeader>
          {whoami !== null && authStatus?.enabled === true && (
            <CardContent>
              <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(whoami, null, 2)}</pre>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open a ticket</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onOpenTicket} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="grid flex-[2] gap-1.5">
                <Label htmlFor="ticket-title">Title</Label>
                <Input id="ticket-title" name="title" placeholder="What's broken?" required />
              </div>
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="ticket-reporter">Reporter</Label>
                <Input id="ticket-reporter" name="reporter" placeholder="Reporter" required />
              </div>
              <Button type="submit" disabled={busy}>
                Open ticket
              </Button>
            </form>
            {actionError !== null && <p className="mt-3 text-sm text-destructive">{actionError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tickets</CardTitle>
            <CardDescription>
              Served by the same Cloudflare Worker that hosts the Tickets domain on Durable Objects.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tickets.status === "loading" && <p className="text-sm text-muted-foreground">Loading tickets…</p>}
            {tickets.status === "error" && (
              <p className="text-sm text-destructive">Could not load tickets: {tickets.message}</p>
            )}
            {tickets.status === "ready" &&
              (tickets.value.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tickets yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Reporter</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-0" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tickets.value.map((ticket) => (
                      <TableRow key={ticket.id}>
                        <TableCell>
                          <div className="font-medium">{ticket.title}</div>
                          <div className="text-xs text-muted-foreground">{ticket.id}</div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{ticket.reporter}</TableCell>
                        <TableCell>
                          <Badge variant={ticket.status === "open" ? "success" : "secondary"}>{ticket.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {ticket.status === "open" && (
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onCloseTicket(ticket.id)}>
                              Close
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ))}
          </CardContent>
        </Card>
      </ShellBody>
      <Toaster />
    </Shell>
  );
};
