import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2Icon } from "@terrarium/ui/lib/icons";
import { api, type AppRow, type AppAcl } from "../api";
import { Badge } from "@terrarium/ui/components/badge";
import { Button } from "@terrarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@terrarium/ui/components/card";
import { Input } from "@terrarium/ui/components/input";
import { Label } from "@terrarium/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terrarium/ui/components/select";
import { Separator } from "@terrarium/ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@terrarium/ui/components/tabs";
import { toast } from "@terrarium/ui/lib/toast";
import { Check, Loader2, X } from "lucide-react";

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
  const previews = useQuery({
    queryKey: ["previews", name] as const,
    queryFn: () => api.previews(),
    select: (data) => data.previews.filter((preview) => preview.previewOf === name),
  });
  const history = useQuery({
    queryKey: ["history", name] as const,
    queryFn: () => api.appHistory(name),
  });
  const acl = useQuery({
    queryKey: ["acl", name] as const,
    queryFn: () => api.appAcl(name),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteApp(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      void queryClient.invalidateQueries({ queryKey: ["directory"] });
      toast.success(`Deleted ${name}`);
      void navigate({ to: "/" });
    },
    onError: (error) => toast.error(message(error)),
  });

  const createPreview = useMutation({
    mutationFn: (pr: string) => api.createPreview(name, pr),
    onSuccess: (_result, pr) => {
      void queryClient.invalidateQueries({ queryKey: ["previews", name] });
      void queryClient.invalidateQueries({ queryKey: ["history", name] });
      toast.success(`Preview for PR ${pr} provisioning`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const invalidateAcl = () => queryClient.invalidateQueries({ queryKey: ["acl", name] });

  const setVisibility = useMutation({
    mutationFn: (visibility: "internal" | "restricted") => api.setVisibility(name, visibility),
    onSuccess: (_result, visibility) => {
      void invalidateAcl();
      toast.success(`${name} is now ${visibility}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const addMember = useMutation({
    mutationFn: ({ sub, role }: { sub: string; role: "admin" | "member" }) => api.addAclMember(name, sub, role),
    onSuccess: (_result, { sub, role }) => {
      void invalidateAcl();
      toast.success(`Added ${sub} as ${role}`);
    },
    onError: (error) => toast.error(message(error)),
  });

  const removeMember = useMutation({
    mutationFn: (sub: string) => api.removeAclMember(name, sub),
    onSuccess: (_result, sub) => {
      void invalidateAcl();
      toast.success(`Removed ${sub}`);
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
        <Link to="/">
          <Button variant="ghost" size="sm">← Back to apps</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {name}
            {app?.previewOf != null && <Badge variant="secondary">preview of {app.previewOf}</Badge>}
          </CardTitle>
          {app !== null && (
            <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
              <span>{app.url}</span>
              <span className="text-muted-foreground">· last seen {app.lastSeenAt ?? "never"}</span>
              {app.lastError !== null && <span className="text-destructive">· last error {app.lastError}</span>}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="tools">
            <TabsList>
              <TabsTrigger value="tools">Tools ({tools.length})</TabsTrigger>
              <TabsTrigger value="previews">Previews ({previews.data?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="history">Deploy history</TabsTrigger>
              <TabsTrigger value="access">Access</TabsTrigger>
            </TabsList>

            <TabsContent value="tools" className="flex flex-col gap-4 pt-4">
              {directory.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
              {directory.isError && <p className="text-sm text-destructive">⚠ {message(directory.error)}</p>}
              <div className="flex flex-col gap-2">
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
            </TabsContent>

            <TabsContent value="previews" className="flex flex-col gap-4 pt-4">
              <NewPreviewForm
                isPending={createPreview.isPending}
                onSubmit={(pr) => createPreview.mutate(pr)}
              />
              <Separator />
              {previews.isPending && <p className="text-sm text-muted-foreground">Loading previews…</p>}
              {(previews.data?.length ?? 0) === 0 && !previews.isPending ? (
                <p className="text-sm text-muted-foreground">
                  No previews yet. A preview is a PR-scoped copy of this app — own Worker, D1,
                  hostname, and OIDC client — torn down on PR close.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {previews.data?.map((preview) => (
                    <li
                      key={preview.name}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant={statusVariant(preview.status)}>{preview.status}</Badge>
                        <span className="font-medium">{preview.name}</span>
                        {preview.previewPr !== null && (
                          <span className="text-muted-foreground">PR #{preview.previewPr}</span>
                        )}
                      </span>
                      <a
                        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                        href={preview.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {preview.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="history" className="flex flex-col gap-3 pt-4">
              {history.isPending && <p className="text-sm text-muted-foreground">Loading history…</p>}
              {history.isError && <p className="text-sm text-destructive">⚠ {message(history.error)}</p>}
              {(history.data?.history.length ?? 0) === 0 && !history.isPending ? (
                <p className="text-sm text-muted-foreground">No provisioning jobs recorded for this app yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {history.data?.history.map((job) => (
                    <li key={job.jobId} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2">
                          {job.status === "succeeded" ? (
                            <Badge variant="success">succeeded</Badge>
                          ) : job.status === "failed" ? (
                            <Badge variant="destructive">failed</Badge>
                          ) : (
                            <Badge variant="secondary">
                              <Loader2 className="size-3 animate-spin" /> running
                            </Badge>
                          )}
                          <span className="font-medium">{String(job.spec.target ?? "cloudflare")}</span>
                          {(job.spec.previewOf as string | undefined) !== undefined && (
                            <Badge variant="secondary">preview PR #{String(job.spec.previewPr ?? "")}</Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{job.jobId}</span>
                      </div>
                      {job.error !== undefined && (
                        <p className="mt-2 text-xs text-destructive">{job.error}</p>
                      )}
                      <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {job.steps.map((step) => (
                          <li key={step.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {step.state === "done" ? (
                              <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
                            ) : step.state === "failed" ? (
                              <X className="size-3 text-destructive" />
                            ) : step.state === "running" ? (
                              <Loader2 className="size-3 animate-spin text-primary" />
                            ) : (
                              <span className="size-1.5 rounded-full bg-current" />
                            )}
                            {step.label}
                          </li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="access" className="flex flex-col gap-4 pt-4">
              {acl.isPending && <p className="text-sm text-muted-foreground">Loading access…</p>}
              {acl.isError && <p className="text-sm text-destructive">⚠ {message(acl.error)}</p>}
              {acl.data !== undefined && (
                <AccessPanel
                  acl={acl.data}
                  isAdmin={acl.data.caller.isAdmin}
                  onSetVisibility={(visibility) => setVisibility.mutate(visibility)}
                  visibilityPending={setVisibility.isPending}
                  onAddMember={(sub, role) => addMember.mutate({ sub, role })}
                  addMemberPending={addMember.isPending}
                  onRemoveMember={(sub) => removeMember.mutate(sub)}
                  removeMemberPending={removeMember.isPending}
                />
              )}
            </TabsContent>
          </Tabs>

          <div className="mt-4 flex justify-end border-t pt-4">
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

function AccessPanel({
  acl,
  isAdmin,
  onSetVisibility,
  visibilityPending,
  onAddMember,
  addMemberPending,
  onRemoveMember,
  removeMemberPending,
}: {
  acl: AppAcl;
  isAdmin: boolean;
  onSetVisibility: (visibility: "internal" | "restricted") => void;
  visibilityPending: boolean;
  onAddMember: (sub: string, role: "admin" | "member") => void;
  addMemberPending: boolean;
  onRemoveMember: (sub: string) => void;
  removeMemberPending: boolean;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>Visibility</Label>
        <div className="flex items-center gap-3">
          <Select
            value={acl.visibility}
            onValueChange={(value) => onSetVisibility(value as "internal" | "restricted")}
            disabled={!isAdmin || visibilityPending}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">internal</SelectItem>
              <SelectItem value="restricted">restricted</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {acl.visibility === "internal"
              ? "Any authenticated platform user can access this app."
              : "Only named members can access this app."}
          </p>
        </div>
        {acl.createdBy !== null && (
          <p className="text-xs text-muted-foreground">
            Created by <code className="rounded bg-muted px-1 py-0.5">{acl.createdBy}</code>
          </p>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <Label>Members</Label>
        {acl.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No members yet. Admins can manage members and visibility; members can access a restricted app.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {acl.members.map((member) => (
              <li
                key={member.userSub}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{member.userSub}</code>
                  <Badge variant={member.role === "admin" ? "default" : "secondary"}>{member.role}</Badge>
                  {member.source === "external" && <Badge variant="secondary">synced</Badge>}
                </span>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={removeMemberPending}
                    onClick={() => onRemoveMember(member.userSub)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && (
        <>
          <Separator />
          <AddMemberForm isPending={addMemberPending} onSubmit={onAddMember} />
        </>
      )}
    </>
  );
}

function AddMemberForm({
  isPending,
  onSubmit,
}: {
  isPending: boolean;
  onSubmit: (sub: string, role: "admin" | "member") => void;
}) {
  const [sub, setSub] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const trimmed = sub.trim();
  const submit = () => {
    if (trimmed === "" || isPending) return;
    onSubmit(trimmed, role);
    setSub("");
  };
  return (
    <div className="flex items-end gap-2">
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="member-sub">Add member</Label>
        <Input
          id="member-sub"
          placeholder="User sub (from the identity provider)"
          value={sub}
          onChange={(event) => setSub(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </div>
      <Select value={role} onValueChange={(value) => setRole(value as "admin" | "member")}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="member">member</SelectItem>
          <SelectItem value="admin">admin</SelectItem>
        </SelectContent>
      </Select>
      <Button disabled={isPending || trimmed === ""} onClick={submit}>
        {isPending ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}

function NewPreviewForm({ isPending, onSubmit }: { isPending: boolean; onSubmit: (pr: string) => void }) {
  const [pr, setPr] = useState("");
  const trimmed = pr.trim();
  const submit = () => {
    if (trimmed === "" || isPending) return;
    onSubmit(trimmed);
    setPr("");
  };
  return (
    <div className="flex items-end gap-2">
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="preview-pr">New preview</Label>
        <Input
          id="preview-pr"
          placeholder="PR number (e.g. 42)"
          value={pr}
          onChange={(event) => setPr(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </div>
      <Button disabled={isPending || trimmed === ""} onClick={submit}>
        {isPending ? "Provisioning…" : "Create preview"}
      </Button>
    </div>
  );
}
