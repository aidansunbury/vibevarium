import { useState } from "react";
import { api } from "./api";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Input } from "@terrarium/ui/components/input";
import { Label } from "@terrarium/ui/components/label";
import { toast } from "@terrarium/ui/lib/toast";

export const ScaffoldForm = ({ onScaffolded }: { readonly onScaffolded: () => void }) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const created = await api("/scaffold", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setResult(created);
      setName("");
      onScaffolded();
      toast.success(`Scaffolded ${name.trim()}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scaffold a new app</CardTitle>
        <CardDescription>
          POST /scaffold — creates the repo, boots the app, registers it, and runs discovery.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="scaffold-name">App name</Label>
            <Input
              id="scaffold-name"
              placeholder="app-name (lower-kebab)"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && !busy && name.trim() !== "" && void submit()}
            />
          </div>
          <Button disabled={busy || name.trim() === ""} onClick={() => void submit()}>
            {busy ? "Scaffolding…" : "Scaffold"}
          </Button>
        </div>
        {error !== null && <p className="text-sm text-destructive">⚠ {error}</p>}
        {result !== null && (
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>
        )}
      </CardContent>
    </Card>
  );
};
