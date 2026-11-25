import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../../api";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
import { Separator } from "@vibevarium/ui/components/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vibevarium/ui/components/table";
import { toast } from "@vibevarium/ui/lib/toast";
import { PlugIcon } from "@vibevarium/ui/lib/icons";
import { ConnectionLogo } from "./connection-logo";

const integrationsQuery = { queryKey: ["integrations"] as const, queryFn: () => api.integrations() };
const grantsQuery = { queryKey: ["integrations", "grants"] as const, queryFn: () => api.integrationGrants() };

export function ProxiedSecrets() {
  const queryClient = useQueryClient();
  const integrations = useQuery(integrationsQuery);
  const grants = useQuery(grantsQuery);
  const [grantForm, setGrantForm] = useState({ integration: "", app: "" });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["integrations"] });

  const grant = useMutation({
    mutationFn: () => api.grantIntegration(grantForm.integration, grantForm.app),
    onSuccess: () => {
      setGrantForm({ integration: "", app: "" });
      invalidate();
      toast.success(`Granted ${grantForm.app} access to ${grantForm.integration}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const revoke = useMutation({
    mutationFn: ({ integration, app }: { integration: string; app: string }) => api.revokeIntegration(integration, app),
    onSuccess: (_result, { integration, app }) => {
      invalidate();
      toast.success(`Revoked ${app} from ${integration}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const audit = useMutation({
    mutationFn: (integration: string) => api.integrationAudit(integration),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const grantPairs = grants.data?.grants ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugIcon className="size-5 text-muted-foreground" /> Proxied secrets
        </CardTitle>
        <CardDescription>
          Shared credentials registered in <code>connections.config.ts</code>. Apps use them through the proxy without seeing their values.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {integrations.isError && <p className="text-sm text-destructive">⚠ {errorMessage(integrations.error)}</p>}
        {integrations.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : integrations.isSuccess && integrations.data.integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No shared credentials registered. Add one under <code>proxiedSecrets</code> in <code>connections.config.ts</code>.
          </p>
        ) : !integrations.isSuccess ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Secret</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Grants</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {integrations.data.integrations.map((integration) => (
                <TableRow key={integration.name}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <ConnectionLogo displayName={integration.displayName} logoUrl={integration.logoUrl} />
                      {integration.displayName}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{integration.baseUrl}</TableCell>
                  <TableCell><code className="text-xs">{integration.secret}</code></TableCell>
                  <TableCell>
                    {integration.tokenConfigured
                      ? <Badge variant="success">configured</Badge>
                      : <Badge variant="destructive">missing</Badge>}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {grantPairs.filter((pair) => pair.integration === integration.name).map((pair) => (
                        <Badge key={pair.app} variant="secondary" className="gap-1">
                          {pair.app}
                          <button
                            type="button"
                            className="ml-0.5 rounded-full hover:text-destructive"
                            aria-label={`revoke ${pair.app}`}
                            onClick={() => revoke.mutate({ integration: pair.integration, app: pair.app })}
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell><Button variant="ghost" size="sm" onClick={() => audit.mutate(integration.name)}>audit</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Separator />
        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Grant app access</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="grant-integration">Proxied secret</Label>
              <Input id="grant-integration" placeholder="integration" value={grantForm.integration} onChange={(event) => setGrantForm({ ...grantForm, integration: event.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="grant-app">App</Label>
              <Input id="grant-app" placeholder="app" value={grantForm.app} onChange={(event) => setGrantForm({ ...grantForm, app: event.target.value })} />
            </div>
            <Button disabled={grant.isPending || grantForm.integration === "" || grantForm.app === ""} onClick={() => grant.mutate()}>
              Grant
            </Button>
          </div>
        </div>

        {audit.isSuccess && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Proxy audit</h4>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(audit.data.audit, null, 2)}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
