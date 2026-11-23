import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RadarIcon, RefreshCwIcon } from "@terrarium/ui/lib/icons";
import { api, isUnauthenticated, type AppRow } from "../api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@terrarium/ui/components/table";
import { toast } from "@terrarium/ui/lib/toast";

export const Route = createFileRoute("/")({ component: GalleryPage });

export const appsQuery = {
  queryKey: ["apps"] as const,
  queryFn: () => api.apps(),
};

const statusVariant = (status: AppRow["status"]) =>
  status === "up" ? "success" : status === "down" ? "destructive" : "secondary";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function GalleryPage() {
  const queryClient = useQueryClient();
  const apps = useQuery(appsQuery);
  const discovery = useMutation({
    mutationFn: () => api.discover(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      void queryClient.invalidateQueries({ queryKey: ["directory"] });
      toast.success("Discovery complete");
    },
    onError: (error) => toast.error(message(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registered apps</CardTitle>
        <CardDescription>Apps registered with the gateway, with status and last-seen time.</CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 flex gap-2 self-start justify-self-end">
          <Button variant="outline" size="sm" onClick={() => apps.refetch()} disabled={apps.isFetching}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => discovery.mutate()} disabled={discovery.isPending}>
            <RadarIcon data-icon="inline-start" />
            {discovery.isPending ? "Running…" : "Run discovery"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {apps.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {apps.isError && (
          <p className="text-sm text-destructive">
            {isUnauthenticated(apps.error) ? "Session expired — log in again." : `⚠ ${message(apps.error)}`}
          </p>
        )}
        {apps.isSuccess &&
          (apps.data.apps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No apps registered. <Link to="/scaffold" className="underline">Scaffold one</Link>.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.data.apps.map((app) => (
                  <TableRow key={app.name} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link to="/apps/$name" params={{ name: app.name }} className="hover:underline">
                        {app.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{app.url}</TableCell>
                    <TableCell className="text-muted-foreground">{app.lastSeenAt ?? "never"}</TableCell>
                    <TableCell>
                      <Link to="/apps/$name" params={{ name: app.name }}><Button variant="ghost" size="sm">details</Button></Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </CardContent>
    </Card>
  );
}
