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

export const Route = createFileRoute("/secrets")({ component: SecretsPage });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function SecretsPage() {
  const queryClient = useQueryClient();
  const [app, setApp] = useState("");
  const appScope = app.trim() === "" ? undefined : app.trim();
  const secrets = useQuery({
    queryKey: ["secrets", appScope ?? null] as const,
    queryFn: () => api.secrets(appScope),
  });
  const [form, setForm] = useState({ reference: "", value: "" });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["secrets"] });
  };

  const put = useMutation({
    mutationFn: () => api.putSecret({ reference: form.reference, value: form.value, ...(appScope === undefined ? {} : { app: appScope }) }),
    onSuccess: () => {
      setForm({ reference: "", value: "" });
      invalidate();
      toast.success(`Set secret ${form.reference}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const remove = useMutation({
    mutationFn: (reference: string) => api.deleteSecret(reference, appScope),
    onSuccess: (_r, reference) => {
      invalidate();
      toast.success(`Deleted ${reference}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const rows = secrets.data?.secrets ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Set-only: see which secrets exist and set or overwrite them. Values are never shown or read back.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-1.5 sm:max-w-sm">
          <Label htmlFor="secret-app">Scope</Label>
          <Input
            id="secret-app"
            placeholder="platform (leave blank) or an app name"
            value={app}
            onChange={(e) => setApp(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {appScope === undefined
              ? "Platform secrets — superadmin only."
              : `App secrets for ${appScope} — that app's admins.`}
          </p>
        </div>

        {secrets.isError && <p className="text-sm text-destructive">⚠ {message(secrets.error)}</p>}
        {secrets.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No secrets in this scope.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Last changed</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((secret) => (
                <TableRow key={secret.name}>
                  <TableCell className="font-medium">{secret.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">set</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {secret.lastChangedDate === undefined ? "—" : new Date(secret.lastChangedDate).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(secret.name)}>
                      delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Separator />

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Set a secret</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="secret-ref">Reference</Label>
              <Input
                id="secret-ref"
                placeholder="e.g. openai-api-key"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                type="password"
                placeholder="the secret value (write-only)"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                autoComplete="off"
              />
            </div>
            <Button
              disabled={put.isPending || form.reference === "" || form.value === ""}
              onClick={() => put.mutate()}
            >
              Set
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Setting an existing reference overwrites it. The value is stored encrypted and is never displayed here again.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
