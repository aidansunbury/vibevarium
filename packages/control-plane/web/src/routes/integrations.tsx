import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
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
import { PlugIcon } from "@vibevarium/ui/lib/icons";

export const Route = createFileRoute("/integrations")({ component: IntegrationsPage });

const integrationsQuery = { queryKey: ["integrations"] as const, queryFn: () => api.integrations() };
const grantsQuery = { queryKey: ["integrations", "grants"] as const, queryFn: () => api.integrationGrants() };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function IntegrationsPage() {
  const queryClient = useQueryClient();
  const integrations = useQuery(integrationsQuery);
  const grants = useQuery(grantsQuery);
  const [form, setForm] = useState({ name: "", baseUrl: "", tokenEnv: "" });
  const [grantForm, setGrantForm] = useState({ integration: "", app: "" });

  const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ["integrations"] });
  };

  const create = useMutation({
    mutationFn: () => api.createIntegration(form),
    onSuccess: () => {
      setForm({ name: "", baseUrl: "", tokenEnv: "" });
      invalidate();
      toast.success(`Registered integration ${form.name}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const grant = useMutation({
    mutationFn: () => api.grantIntegration(grantForm.integration, grantForm.app),
    onSuccess: () => {
      setGrantForm({ integration: "", app: "" });
      invalidate();
      toast.success(`Granted ${grantForm.app} access to ${grantForm.integration}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const revoke = useMutation({
    mutationFn: ({ integration, app }: { integration: string; app: string }) =>
      api.revokeIntegration(integration, app),
    onSuccess: (_r, { integration, app }) => {
      invalidate();
      toast.success(`Revoked ${app} from ${integration}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const audit = useMutation({
    mutationFn: (integration: string) => api.integrationAudit(integration),
    onError: (error) => toast.error(message(error)),
  });

  const grantPairs = grants.data?.grants ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugIcon className="size-5 text-muted-foreground" />
          Integrations
        </CardTitle>
        <CardDescription>Connection proxy: register integrations, grant app access, view the proxy audit.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {integrations.isError && <p className="text-sm text-destructive">⚠ {message(integrations.error)}</p>}
        {integrations.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : integrations.isSuccess && integrations.data.integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No integrations registered.</p>
        ) : !integrations.isSuccess ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Token env</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Grants</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {integrations.data.integrations.map((integration) => (
                <TableRow key={integration.name}>
                  <TableCell className="font-medium">{integration.name}</TableCell>
                  <TableCell className="text-muted-foreground">{integration.baseUrl}</TableCell>
                  <TableCell className="text-muted-foreground">{integration.tokenEnv}</TableCell>
                  <TableCell>
                    {integration.tokenConfigured
                      ? <Badge variant="success">configured</Badge>
                      : <Badge variant="destructive">missing</Badge>}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {grantPairs.filter((g) => g.integration === integration.name).map((g) => (
                        <Badge key={g.app} variant="secondary" className="gap-1">
                          {g.app}
                          <button
                            type="button"
                            className="ml-0.5 rounded-full hover:text-destructive"
                            aria-label={`revoke ${g.app}`}
                            onClick={() => revoke.mutate({ integration: g.integration, app: g.app })}
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => audit.mutate(integration.name)}>
                      audit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Separator />

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Register integration</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="int-name">Name</Label>
              <Input id="int-name" placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="int-baseurl">Base URL</Label>
              <Input id="int-baseurl" placeholder="https://api.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="int-tokenenv">Token env var</Label>
              <Input id="int-tokenenv" placeholder="TOKEN_ENV_VAR" value={form.tokenEnv} onChange={(e) => setForm({ ...form, tokenEnv: e.target.value })} />
            </div>
            <Button
              disabled={create.isPending || form.name === "" || form.baseUrl === "" || form.tokenEnv === ""}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </div>
        </div>

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Grant app access</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="grant-integration">Integration</Label>
              <Input id="grant-integration" placeholder="integration" value={grantForm.integration} onChange={(e) => setGrantForm({ ...grantForm, integration: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="grant-app">App</Label>
              <Input id="grant-app" placeholder="app" value={grantForm.app} onChange={(e) => setGrantForm({ ...grantForm, app: e.target.value })} />
            </div>
            <Button disabled={grant.isPending || grantForm.integration === "" || grantForm.app === ""} onClick={() => grant.mutate()}>
              Grant
            </Button>
          </div>
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
