import { useCallback, useEffect, useState } from "react";
import { api, type AuditRow, type ConnectionView, type GrantView, type ProviderView } from "./api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Separator } from "@terrarium/ui/components/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@terrarium/ui/components/table";
import { toast } from "@terrarium/ui/lib/toast";

const statusVariant = (status: string) =>
  status === "active" || status === "approved"
    ? "success" as const
    : status === "revoked"
    ? "destructive" as const
    : "secondary" as const;

/**
 * Connections panel (docs/connections.md): the user's provider connections,
 * connect buttons per provider, pending grant requests with approve/deny, and
 * an app-centric view of grants.
 */
export const ConnectionsPanel = () => {
  const [providers, setProviders] = useState<Array<ProviderView>>([]);
  const [connections, setConnections] = useState<Array<ConnectionView>>([]);
  const [grants, setGrants] = useState<Array<GrantView>>([]);
  const [audit, setAudit] = useState<Array<AuditRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [providersBody, connectionsBody, grantsBody] = await Promise.all([
        api<{ providers: Array<ProviderView> }>("/connections/providers"),
        api<{ connections: Array<ConnectionView> }>("/connections"),
        api<{ grants: Array<GrantView> }>("/grants"),
      ]);
      setProviders(providersBody.providers);
      setConnections(connectionsBody.connections);
      setGrants(grantsBody.grants);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (provider: string) => {
    try {
      const started = await api<{ authorization_url: string }>("/connections/start", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      // Full-page redirect to the provider's authorize URL; the callback
      // returns to the control plane.
      globalThis.location.assign(started.authorization_url);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revokeConnection = async (connectionId: string) => {
    try {
      await api("/connections/revoke", { method: "POST", body: JSON.stringify({ connectionId }) });
      await load();
      toast.success("Connection revoked (all its grants died with it)");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revokeGrant = async (grantId: string) => {
    try {
      await api("/grants/revoke", { method: "POST", body: JSON.stringify({ grantId }) });
      await load();
      toast.success("Grant revoked");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const showAudit = async (provider: string) => {
    try {
      const body = await api<{ audit: Array<AuditRow> }>(`/integrations/${encodeURIComponent(provider)}/audit`);
      setAudit(body.audit);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const connectionFor = (provider: string) => connections.find((connection) => connection.provider === provider);
  const grantsByApp = grants.reduce<Record<string, Array<GrantView>>>((acc, grant) => {
    (acc[grant.app_id] ??= []).push(grant);
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <CardDescription>
          Connect a provider once, grant apps access to it. Tokens are held (encrypted) by the control plane.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && <p className="text-sm text-destructive">⚠ {error}</p>}

        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No providers registered. Set GITHUB_OAUTH_CLIENT_ID/SECRET (see CONNECTIONS-SPIKE.md) or register a
            fake-oauth provider for local development.
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
              {providers.map((provider) => {
                const connection = connectionFor(provider.name);
                return (
                  <TableRow key={provider.name}>
                    <TableCell className="font-medium">{provider.displayName}</TableCell>
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
                              disabled={!provider.configured}
                              title={provider.configured ? undefined : "Provider OAuth client not configured"}
                              onClick={() => void connect(provider.name)}
                            >
                              Connect
                            </Button>
                          )
                          : (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => void showAudit(provider.name)}>
                                audit
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => void revokeConnection(connection.connection_id)}>
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
                        <Button variant="ghost" size="sm" onClick={() => void revokeGrant(grant.grant_id)}>
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

        {audit !== null && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Proxy audit</h4>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(audit, null, 2)}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
