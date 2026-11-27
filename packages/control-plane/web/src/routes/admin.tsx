import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, isUnauthenticated, type PlatformUser } from "../api";
import { useSession } from "./__root";
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
import { RefreshCwIcon, ShieldIcon, UserPlusIcon } from "@vibevarium/ui/lib/icons";
import { toast } from "@vibevarium/ui/lib/toast";

export const Route = createFileRoute("/admin")({ component: AdminPage });

const usersQueryKey = ["platform-users"] as const;

const formatTimestamp = (value: string | null): string => {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

function AdminPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [manualSub, setManualSub] = useState("");
  const [promotingSub, setPromotingSub] = useState<string | null>(null);

  const users = useQuery({
    queryKey: usersQueryKey,
    queryFn: () => api.platformUsers(),
    enabled: session.isSuperadmin,
  });

  const promote = useMutation({
    mutationFn: async (sub: string) => {
      setPromotingSub(sub);
      try {
        return await api.grantSuperadmin(sub);
      } finally {
        setPromotingSub(null);
      }
    },
    onSuccess: (_result, sub) => {
      void queryClient.invalidateQueries({ queryKey: usersQueryKey });
      toast.success(`Promoted ${sub} to super admin`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!session.isSuperadmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldIcon className="size-5 text-muted-foreground" />
            Admin
          </CardTitle>
          <CardDescription>Super admin access is required to view this page.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const handleManualPromote = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = manualSub.trim();
    if (trimmed.length === 0) return;
    promote.mutate(trimmed, {
      onSuccess: () => setManualSub(""),
    });
  };

  const handlePromoteRow = (user: PlatformUser) => {
    const label = user.name ? `${user.name} (${user.sub})` : user.sub;
    if (!globalThis.confirm?.(`Promote ${label} to super admin?`)) return;
    promote.mutate(user.sub);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldIcon className="size-5 text-muted-foreground" />
            Platform users
          </CardTitle>
          <CardDescription>
            Users known to the control plane. Super admins can promote other users to super admin.
          </CardDescription>
          <div className="col-start-2 row-span-2 row-start-1 flex gap-2 self-start justify-self-end">
            <Button variant="outline" size="sm" onClick={() => users.refetch()} disabled={users.isFetching}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {users.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {users.isError && (
            <p className="text-sm text-destructive">
              {isUnauthenticated(users.error) ? "Session expired — log in again." : `⚠ ${errorMessage(users.error)}`}
            </p>
          )}
          {users.isSuccess &&
            (users.data.users.length === 0 ? (
              <p className="text-sm text-muted-foreground">No users recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead className="w-0 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.data.users.map((user) => {
                    const isCurrent = session.actor?.sub === user.sub;
                    const isPromoting = promote.isPending && promotingSub === user.sub;
                    return (
                      <TableRow key={user.sub}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {user.name ?? user.sub}
                              {isCurrent && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                            </span>
                            {user.email !== null && (
                              <span className="text-xs text-muted-foreground">{user.email}</span>
                            )}
                            <span className="font-mono text-xs text-muted-foreground">{user.sub}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={user.isSuperadmin ? "default" : "secondary"}>
                              {user.isSuperadmin ? "Super admin" : "Member"}
                            </Badge>
                            {user.superadminSource === "env" && (
                              <Badge variant="outline">env</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatTimestamp(user.lastSeenAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {!user.isSuperadmin && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePromoteRow(user)}
                              disabled={promote.isPending}
                            >
                              <UserPlusIcon data-icon="inline-start" />
                              {isPromoting ? "Promoting…" : "Promote to super admin"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ))}

          <Separator />

          <form onSubmit={handleManualPromote} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="promote-sub">Promote by user ID</Label>
              <Input
                id="promote-sub"
                placeholder="Paste a user sub (UUID)"
                value={manualSub}
                onChange={(event) => setManualSub(event.target.value)}
                disabled={promote.isPending}
              />
            </div>
            <Button type="submit" variant="outline" disabled={promote.isPending || manualSub.trim().length === 0}>
              <UserPlusIcon data-icon="inline-start" />
              Promote
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
