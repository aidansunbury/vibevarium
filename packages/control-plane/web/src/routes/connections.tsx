import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GrantView } from "../api";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Separator } from "@vibevarium/ui/components/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vibevarium/ui/components/table";
import { toast } from "@vibevarium/ui/lib/toast";
import { LinkIcon } from "@vibevarium/ui/lib/icons";

export const Route = createFileRoute("/connections")({ component: ConnectionsPage });

const providersQuery = { queryKey: ["connections", "providers"] as const, queryFn: () => api.providers() };
const connectionsQuery = { queryKey: ["connections", "list"] as const, queryFn: () => api.connections() };
const grantsQuery = { queryKey: ["connections", "grants"] as const, queryFn: () => api.grants() };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const statusVariant = (status: string): "success" | "destructive" | "secondary" =>
  status === "active" || status === "approved" ? "success" : status === "revoked" ? "destructive" : "secondary";

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const providers = useQuery(providersQuery);
  const connections = useQuery(connectionsQuery);
  const grants = useQuery(grantsQuery);

  const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ["connections"] });
  };

  const connect = useMutation({
    mutationFn: (provider: string) => api.startConnection(provider),
    onSuccess: (started) => {
      // Full-page redirect to the provider's authorize URL; the callback
      // returns to the control plane.
      globalThis.location.assign(started.authorization_url);
    },
    onError: (error) => toast.error(message(error)),
  });

  const revokeConnection = useMutation({
    mutationFn: (connectionId: string) => api.revokeConnection(connectionId),
    onSuccess: () => {
      invalidate();
      toast.success("Connection revoked (all its grants died with it)");
    },
    onError: (error) => toast.error(message(error)),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) => api.revokeGrant(grantId),
    onSuccess: () => {
      invalidate();
      toast.success("Grant revoked");
    },
    onError: (error) => toast.error(message(error)),
  });

  const audit = useMutation({
    mutationFn: (provider: string) => api.integrationAudit(provider),
    onError: (error) => toast.error(message(error)),
  });

  const connectionRows = connections.data?.connections ?? [];
  const grantRows = grants.data?.grants ?? [];
  const connectionFor = (provider: string) => connectionRows.find((c) => c.provider === provider);
  const grantsByApp = grantRows.reduce<Record<string, Array<GrantView>>>((acc, grant) => {
    (acc[grant.app_id] ??= []).push(grant);
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="size-5 text-muted-foreground" />
          Connections
        </CardTitle>
        <CardDescription>
          Connect a provider once, grant apps access to it. Tokens are held (encrypted) by the control plane.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {providers.isError && <p className="text-sm text-destructive">⚠ {message(providers.error)}</p>}
        {providers.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !providers.isSuccess ? null : providers.data.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No providers registered. Enable github and/or linear with TERRARIUM_CONNECTION_PROVIDERS and configure
            their OAuth credentials, or register a fake-oauth provider for local development.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.data.providers.map((provider) => {
                const connection = connectionFor(provider.name);
                return (
                  <TableRow key={provider.name}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {provider.logoUrl !== undefined && (
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-white p-1">
                            <img src={provider.logoUrl} alt="" className="size-full" />
                          </span>
                        )}
                        {provider.displayName}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {connection?.provider_account.label ?? "—"}
                    </TableCell>
                    <TableCell>
                      {connection === undefined
                        ? <Badge variant="secondary">not connected</Badge>
                        : <Badge variant={statusVariant(connection.status)}>{connection.status}</Badge>}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {(connection?.granted_scopes ?? provider.defaultScopes).map((scope) => (
                          <Badge key={scope} variant="secondary">{scope}</Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex gap-1">
                        {connection === undefined || connection.status !== "active"
                          ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!provider.configured || connect.isPending}
                              title={provider.configured ? undefined : "Provider OAuth client not configured"}
                              onClick={() => connect.mutate(provider.name)}
                            >
                              Connect
                            </Button>
                          )
                          : (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => audit.mutate(provider.name)}>
                                audit
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => revokeConnection.mutate(connection.connection_id)}>
                                revoke
                              </Button>
                            </>
                          )}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Separator />

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Grants per app</h4>
          {Object.keys(grantsByApp).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No grants yet. An app requests one via POST /grants/request and you approve it on the consent screen.
            </p>
          ) : (
            Object.entries(grantsByApp).map(([app, appGrants]) => (
              <div key={app} className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">{app}</div>
                <div className="flex flex-col gap-2">
                  {appGrants.map((grant) => (
                    <div key={grant.grant_id} className="flex items-center gap-2 text-sm">
                      <Badge variant={statusVariant(grant.status)}>{grant.status}</Badge>
                      <span className="text-muted-foreground">{grant.provider}</span>
                      <span className="flex flex-wrap gap-1">
                        {grant.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary">{scope}</Badge>
                        ))}
                      </span>
                      {grant.status === "approved" && (
                        <Button variant="ghost" size="sm" onClick={() => revokeGrant.mutate(grant.grant_id)}>
                          revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {audit.isSuccess && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Proxy audit</h4>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(audit.data.audit, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
