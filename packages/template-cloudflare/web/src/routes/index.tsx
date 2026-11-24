import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isUnauthenticated, redirectToLogin, redirectToLogout } from "../client";
import { useSession } from "./__root";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vibevarium/ui/components/table";
import { Shell, ShellBody, ShellHeader, ShellHeaderActions, ShellHeaderTitle } from "@vibevarium/ui/layout/shell";
import { Toaster } from "@vibevarium/ui/components/sonner";
import { toast } from "@vibevarium/ui/lib/toast";

export const Route = createFileRoute("/")({
  component: TicketsPage,
});

/** TanStack Query owns the server state; the Effect client owns the wire. */
export const ticketsQuery = {
  queryKey: ["tickets", "list"] as const,
  queryFn: () => api.tickets.list(),
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A mutation is: run the command, read the list back at its version (read-your-write). */
const useTicketMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (receipt: Awaited<ReturnType<typeof api.tickets.open>>) => {
      const list = await api.tickets.list({ atLeast: receipt });
      return list;
    },
    onSuccess: (list) => {
      queryClient.setQueryData(ticketsQuery.queryKey, list);
    },
    onError: (error) => {
      if (isUnauthenticated(error)) {
        redirectToLogin();
        return;
      }
      toast.error(errorMessage(error));
    },
  });
};

function TicketsPage() {
  const session = useSession();
  const tickets = useQuery(ticketsQuery);
  const mutation = useTicketMutation();

  const onOpenTicket = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const title = field("title");
    const reporter = field("reporter");
    if (title === "" || reporter === "") return;
    event.currentTarget.reset();
    void (async () => {
      try {
        const receipt = await api.tickets.open({ title, reporter });
        await mutation.mutateAsync(receipt);
        toast.success(`Opened “${title}”`);
      } catch (error) {
        if (isUnauthenticated(error)) redirectToLogin();
        else toast.error(errorMessage(error));
      }
    })();
  };

  const onCloseTicket = (id: string) =>
    void (async () => {
      try {
        const receipt = await api.tickets.close(id);
        await mutation.mutateAsync(receipt);
        toast.success(`Closed ${id}`);
      } catch (error) {
        if (isUnauthenticated(error)) redirectToLogin();
        else toast.error(errorMessage(error));
      }
    })();

  const actor = session.actor;
  const displayName = actor?.name ?? actor?.sub;

  return (
    <Shell>
      <ShellHeader>
        <ShellHeaderTitle>
          <span className="font-semibold">Tickets</span>
          <span className="text-muted-foreground">a Vibevarium app</span>
        </ShellHeaderTitle>
        <ShellHeaderActions>
          {!session.authEnabled && <Badge variant="secondary">auth off</Badge>}
          {session.authEnabled && actor !== null && (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-muted-foreground sm:inline">{displayName}</span>
              <Button variant="outline" size="sm" onClick={redirectToLogout}>
                Log out
              </Button>
            </div>
          )}
        </ShellHeaderActions>
      </ShellHeader>

      <ShellBody className="max-w-3xl">
        {session.authEnabled && actor !== null && (
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
              <Button type="submit" disabled={mutation.isPending}>
                Open ticket
              </Button>
            </form>
            {mutation.isError && <p className="mt-3 text-sm text-destructive">{errorMessage(mutation.error)}</p>}
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
            {tickets.isPending && <p className="text-sm text-muted-foreground">Loading tickets…</p>}
            {tickets.isError && (
              <p className="text-sm text-destructive">Could not load tickets: {errorMessage(tickets.error)}</p>
            )}
            {tickets.isSuccess &&
              (tickets.data.tickets.length === 0 ? (
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
                    {tickets.data.tickets.map((ticket) => (
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
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={mutation.isPending}
                              onClick={() => onCloseTicket(ticket.id)}
                            >
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
}
