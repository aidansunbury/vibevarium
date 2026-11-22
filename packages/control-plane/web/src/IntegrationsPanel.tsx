import { useCallback, useEffect, useState } from "react";
import { api, type AuditRow, type IntegrationView } from "./api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Input } from "@terrarium/ui/components/input";
import { Label } from "@terrarium/ui/components/label";
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

export const IntegrationsPanel = () => {
  const [integrations, setIntegrations] = useState<Array<IntegrationView>>([]);
  const [grants, setGrants] = useState<Array<{ app: string; integration: string }>>([]);
  const [audit, setAudit] = useState<{ integration: string; rows: Array<AuditRow> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", baseUrl: "", tokenEnv: "" });
  const [grantForm, setGrantForm] = useState({ integration: "", app: "" });

  const load = useCallback(async () => {
    try {
      const [listBody, grantsBody] = await Promise.all([
        api<{ integrations: Array<IntegrationView> }>("/integrations"),
        api<{ grants: Array<{ app: string; integration: string }> }>("/integrations/grants"),
      ]);
      setIntegrations(listBody.integrations);
      setGrants(grantsBody.grants);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    try {
      await api("/integrations", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", baseUrl: "", tokenEnv: "" });
      await load();
      toast.success(`Registered integration ${form.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const grant = async () => {
    try {
      await api(`/integrations/${encodeURIComponent(grantForm.integration)}/grants`, {
        method: "POST",
        body: JSON.stringify({ app: grantForm.app }),
      });
      setGrantForm({ integration: "", app: "" });
      await load();
      toast.success(`Granted ${grantForm.app} access to ${grantForm.integration}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revoke = async (integration: string, app: string) => {
    try {
      await api(`/integrations/${encodeURIComponent(integration)}/grants/${encodeURIComponent(app)}`, { method: "DELETE" });
      await load();
      toast.success(`Revoked ${app} from ${integration}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const showAudit = async (integration: string) => {
    try {
      const body = await api<{ audit: Array<AuditRow> }>(`/integrations/${encodeURIComponent(integration)}/audit`);
      setAudit({ integration, rows: body.audit });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>Connection proxy: register integrations, grant app access, view the proxy audit.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null && <p className="text-sm text-destructive">⚠ {error}</p>}

        {integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No integrations registered.</p>
        ) : (
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
              {integrations.map((integration) => (
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
                      {grants.filter((g) => g.integration === integration.name).map((g) => (
                        <Badge key={g.app} variant="secondary" className="gap-1">
                          {g.app}
                          <button
                            type="button"
                            className="ml-0.5 rounded-full hover:text-destructive"
                            aria-label={`revoke ${g.app}`}
                            onClick={() => void revoke(g.integration, g.app)}
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => void showAudit(integration.name)}>
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
            <Button disabled={form.name === "" || form.baseUrl === "" || form.tokenEnv === ""} onClick={() => void create()}>
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
            <Button disabled={grantForm.integration === "" || grantForm.app === ""} onClick={() => void grant()}>
              Grant
            </Button>
          </div>
        </div>

        {audit !== null && (
          <div className="grid gap-2">
            <h4 className="text-sm font-medium">Proxy audit — {audit.integration}</h4>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(audit.rows, null, 2)}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
