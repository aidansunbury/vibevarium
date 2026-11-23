import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "@terrarium/ui/lib/icons";
import { api, type AppRow } from "../api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Separator } from "@terrarium/ui/components/separator";
import { toast } from "@terrarium/ui/lib/toast";

export const Route = createFileRoute("/apps/$name")({ component: AppDetailPage });

const directoryQuery = {
  queryKey: ["directory"] as const,
  queryFn: () => api.directory(),
};

const statusVariant = (status: AppRow["status"]) =>
  status === "up" ? "success" : status === "down" ? "destructive" : "secondary";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function AppDetailPage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const directory = useQuery(directoryQuery);

  const remove = useMutation({
    mutationFn: () => api.deleteApp(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["directory"] });
      toast.success(`Deleted ${name}`);
      void navigate({ to: "/" });
    },
    onError: (error) => toast.error(message(error)),
  });

  const app = directory.data?.apps.find((candidate) => candidate.name === name) ?? null;
  const tools = directory.data?.tools.filter((tool) => tool.appName === name) ?? [];

  const confirmDelete = () => {
    if (!globalThis.confirm?.(`Delete app ${name}? This stops the app and removes its registry entry.`)) return;
    remove.mutate();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">← Back to apps</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{name}</CardTitle>
          {app !== null && (
            <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
              <span>{app.url}</span>
              <span className="text-muted-foreground">· last seen {app.lastSeenAt ?? "never"}</span>
              {app.lastError !== null && <span className="text-destructive">· last error {app.lastError}</span>}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {directory.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {directory.isError && <p className="text-sm text-destructive">⚠ {message(directory.error)}</p>}

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
            <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={confirmDelete}>
              <Trash2Icon data-icon="inline-start" />
              {remove.isPending ? "Deleting…" : "Delete app"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
