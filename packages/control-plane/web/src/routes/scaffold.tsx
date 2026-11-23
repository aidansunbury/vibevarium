import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Input } from "@terrarium/ui/components/input";
import { Label } from "@terrarium/ui/components/label";
import { toast } from "@terrarium/ui/lib/toast";

export const Route = createFileRoute("/scaffold")({ component: ScaffoldPage });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ScaffoldPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const scaffold = useMutation({
    mutationFn: (appName: string) => api.scaffold(appName),
    onSuccess: (_result, appName) => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["directory"] });
      toast.success(`Scaffolded ${appName}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === "" || scaffold.isPending) return;
    scaffold.mutate(trimmed);
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
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
          <Button disabled={scaffold.isPending || name.trim() === ""} onClick={submit}>
            {scaffold.isPending ? "Scaffolding…" : "Scaffold"}
          </Button>
        </div>
        {scaffold.isError && <p className="text-sm text-destructive">⚠ {message(scaffold.error)}</p>}
        {scaffold.isSuccess && (
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(scaffold.data, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
