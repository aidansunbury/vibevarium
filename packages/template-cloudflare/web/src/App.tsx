import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  redirectToLogin,
  redirectToLogout,
  UnauthenticatedError,
  type AuthStatus,
  type Me,
  type TicketSummary,
} from "./client";
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
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setTickets({ status: "loading" });
    try {
      const list = await api.listTickets();
      setTickets({ status: "ready", value: list.tickets });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        // No logged-out state: an unauthenticated user goes straight to the
        // hosted sign-in and lands back here authed.
        redirectToLogin();
        return;
      }
      setTickets({ status: "error", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const boot = async () => {
      let status: AuthStatus;
      try {
        status = await api.authStatus();
      } catch {
        status = { enabled: false };
      }
      setAuthStatus(status);
      if (status.enabled) {
        try {
          setMe(await api.me());
        } catch {
          // 401 → no session (or expired): straight to the auth server.
          redirectToLogin();
          return;
        }
      }
      void refresh();
    };
    void boot();
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await refresh();
      } catch (error) {
        if (error instanceof UnauthenticatedError) {
          redirectToLogin();
          return;
        }
        setActionError(errorMessage(error));
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
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

  const actor = me?.actor ?? null;
  const displayName = actor?.name !== undefined ? actor.name : actor?.sub;

  return (
    <Shell>
      <ShellHeader>
        <ShellHeaderTitle>
          <span className="font-semibold">Tickets</span>
          <span className="text-muted-foreground">a Terrarium app</span>
        </ShellHeaderTitle>
        <ShellHeaderActions>
          {authStatus !== null && !authStatus.enabled && <Badge variant="secondary">auth off</Badge>}
          {authStatus?.enabled === true && actor !== null && (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-muted-foreground sm:inline">{displayName}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={redirectToLogout}>
                Log out
              </Button>
            </div>
          )}
        </ShellHeaderActions>
      </ShellHeader>

      <ShellBody className="max-w-3xl">
        {authStatus?.enabled === true && actor !== null && (
          <Card>
            <CardHeader>
              <CardTitle>Session</CardTitle>
              <CardDescription>
                Signed in{displayName !== undefined ? ` as ${displayName}` : ""} ({actor.sub})
              </CardDescription>
            </CardHeader>
          </Card>
        )}

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
