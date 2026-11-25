import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
import { Separator } from "@vibevarium/ui/components/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vibevarium/ui/components/table";
import { toast } from "@vibevarium/ui/lib/toast";
import { Trash2Icon } from "@vibevarium/ui/lib/icons";

/** Per-app Worker secrets, deliberately scoped by the enclosing app detail route. */
export function AppSecretsPanel({ app }: { app: string }) {
  const queryClient = useQueryClient();
  const secrets = useQuery({
    queryKey: ["secrets", app] as const,
    queryFn: () => api.secrets(app),
  });
  const [form, setForm] = useState({ reference: "", value: "" });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["secrets", app] });

  const put = useMutation({
    mutationFn: () => api.putSecret({ ...form, app }),
    onSuccess: () => {
      setForm({ reference: "", value: "" });
      invalidate();
      toast.success(`Set secret ${form.reference} for ${app}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (reference: string) => api.deleteSecret(reference, app),
    onSuccess: (_result, reference) => {
      invalidate();
      toast.success(`Deleted ${reference} from ${app}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const rows = secrets.data?.secrets ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 className="text-sm font-medium">App secrets</h4>
        <p className="text-sm text-muted-foreground">
          Write-only secrets installed on <strong>{app}</strong>. Values are never shown or read back.
        </p>
      </div>

      {secrets.isError && <p className="text-sm text-destructive">⚠ {errorMessage(secrets.error)}</p>}
      {secrets.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : secrets.isError ? null : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets in this app.</p>
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
                <TableCell><Badge variant="secondary">write-only</Badge></TableCell>
                <TableCell className="text-muted-foreground">
                  {secret.lastChangedDate === undefined ? "—" : new Date(secret.lastChangedDate).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" aria-label={`Delete ${secret.name}`} onClick={() => remove.mutate(secret.name)}>
                    <Trash2Icon className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Separator />
      <div className="grid gap-3">
        <h4 className="text-sm font-medium">Set a secret for {app}</h4>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="secret-ref">Reference</Label>
            <Input id="secret-ref" placeholder="e.g. openai-api-key" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input id="secret-value" type="password" placeholder="the secret value (write-only)" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} autoComplete="off" />
          </div>
          <Button disabled={put.isPending || form.reference === "" || form.value === ""} onClick={() => put.mutate()}>Set</Button>
        </div>
        <p className="text-xs text-muted-foreground">Setting an existing reference overwrites it. The value is never displayed here again.</p>
      </div>
    </div>
  );
}
