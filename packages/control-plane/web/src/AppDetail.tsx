import { useCallback, useEffect, useState } from "react";
import { Trash2Icon } from "@terrarium/ui/lib/icons";
import { api, type AppRow, type DirectoryTool } from "./api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@terrarium/ui/components/dialog";
import { Separator } from "@terrarium/ui/components/separator";

const statusVariant = (status: AppRow["status"]) =>
  status === "up" ? "success" : status === "down" ? "destructive" : "secondary";

export const AppDetail = ({ name, onDeleted }: {
  readonly name: string;
  readonly onDeleted: () => void;
}) => {
  const [app, setApp] = useState<AppRow | null>(null);
  const [tools, setTools] = useState<Array<DirectoryTool>>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api<{ apps: Array<AppRow>; tools: Array<DirectoryTool> }>("/directory");
      setApp(body.apps.find((candidate) => candidate.name === name) ?? null);
      setTools(body.tools.filter((tool) => tool.appName === name));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!globalThis.confirm?.(`Delete app ${name}? This stops the app and removes its registry entry.`)) return;
    setDeleting(true);
    try {
      await api(`/apps/${encodeURIComponent(name)}`, { method: "DELETE" });
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
        {app !== null && (
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
            <span>{app.url}</span>
            <span className="text-muted-foreground">· last seen {app.lastSeenAt ?? "never"}</span>
            {app.lastError !== null && <span className="text-destructive">· last error {app.lastError}</span>}
          </DialogDescription>
        )}
      </DialogHeader>

      {error !== null && <p className="text-sm text-destructive">⚠ {error}</p>}

      <Separator />

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Tools ({tools.length})</h4>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">No discovered tools — run discovery.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tools.map((tool) => (
              <li key={tool.gatewayName}>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tool.gatewayName}</code>
                  {tool.stale && <Badge variant="secondary">stale</Badge>}
                </div>
                {tool.descriptor.description !== undefined && (
                  <div className="mt-0.5 text-sm text-muted-foreground">{tool.descriptor.description}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-2 flex justify-end border-t pt-4">
        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void remove()}>
          <Trash2Icon data-icon="inline-start" />
          {deleting ? "Deleting…" : "Delete app"}
        </Button>
      </div>
    </DialogContent>
  );
};
