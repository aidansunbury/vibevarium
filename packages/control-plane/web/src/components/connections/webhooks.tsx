import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../../api";
import { Badge } from "@vibevarium/ui/components/badge";
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
import { Separator } from "@vibevarium/ui/components/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vibevarium/ui/components/table";
import { toast } from "@vibevarium/ui/lib/toast";
import { ZapIcon } from "@vibevarium/ui/lib/icons";
import { ConnectionLogo } from "./connection-logo";

const sourcesQuery = { queryKey: ["events", "sources"] as const, queryFn: () => api.eventSources() };
const subscriptionsQuery = { queryKey: ["events", "subscriptions"] as const, queryFn: () => api.eventSubscriptions() };
const deliveriesQuery = { queryKey: ["events", "deliveries"] as const, queryFn: () => api.eventDeliveries() };

export function Webhooks() {
  const queryClient = useQueryClient();
  const sources = useQuery(sourcesQuery);
  const subscriptions = useQuery(subscriptionsQuery);
  const deliveries = useQuery(deliveriesQuery);
  const [form, setForm] = useState({ app: "", source: "", eventTypes: "", scopes: "" });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["events"] });

  const subscribe = useMutation({
    mutationFn: () => api.subscribeEvent({
      app: form.app,
      source: form.source,
      ...(form.eventTypes.trim() === ""
        ? {}
        : { eventTypes: form.eventTypes.split(",").map((entry) => entry.trim()).filter(Boolean) }),
      ...(form.scopes.trim() === ""
        ? {}
        : { scopes: form.scopes.split(",").map((entry) => entry.trim()).filter(Boolean) }),
    }),
    onSuccess: () => {
      setForm({ app: "", source: "", eventTypes: "", scopes: "" });
      invalidate();
      toast.success("Subscription created");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const unsubscribe = useMutation({
    mutationFn: (id: string) => api.unsubscribeEvent(id),
    onSuccess: () => {
      invalidate();
      toast.success("Subscription removed");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ZapIcon className="size-5 text-muted-foreground" /> Webhooks
        </CardTitle>
        <CardDescription>
          Providers POST once to the control plane; subscriptions fan verified events out to apps. Sources and credential mappings live in <code>connections.config.ts</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sources.isError && <p className="text-sm text-destructive">⚠ {errorMessage(sources.error)}</p>}
        {sources.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : sources.isSuccess && sources.data.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhook sources registered. Add one under <code>webhooks</code> in <code>connections.config.ts</code>.
          </p>
        ) : !sources.isSuccess ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Type header</TableHead>
                <TableHead>Secret</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.data.sources.map((source) => (
                <TableRow key={source.name}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <ConnectionLogo displayName={source.displayName} logoUrl={source.logoUrl} />
                      {source.displayName} <span className="text-muted-foreground">({source.name})</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{source.verification}</TableCell>
                  <TableCell className="text-muted-foreground">{source.eventTypeHeader ?? "—"}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <code className="text-xs">{source.secret}</code>
                      {source.secretConfigured
                        ? <Badge variant="success">configured</Badge>
                        : <Badge variant="destructive">missing</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>{source.enabled ? <Badge variant="secondary">enabled</Badge> : <Badge>disabled</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Separator />
        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Subscriptions</h4>
          {subscriptions.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : subscriptions.isSuccess && subscriptions.data.subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
          ) : !subscriptions.isSuccess ? null : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Event types</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.data.subscriptions.map((subscription) => (
                  <TableRow key={subscription.id}>
                    <TableCell className="font-medium">{subscription.app}</TableCell>
                    <TableCell className="text-muted-foreground">{subscription.source}</TableCell>
                    <TableCell className="text-muted-foreground">{subscription.eventTypes.length === 0 ? "all" : subscription.eventTypes.join(", ")}</TableCell>
                    <TableCell className="text-muted-foreground">{subscription.scopes.length === 0 ? "all" : subscription.scopes.join(", ")}</TableCell>
                    <TableCell>
                      <span className="flex gap-1">
                        <Badge variant={subscription.status === "active" ? "success" : "secondary"}>{subscription.status}</Badge>
                        {!subscription.deliveryConfigured && <Badge variant="destructive">no secret</Badge>}
                      </span>
                    </TableCell>
                    <TableCell><Button variant="ghost" size="sm" onClick={() => unsubscribe.mutate(subscription.id)}>remove</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Subscribe an app</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="sub-app">App</Label>
              <Input id="sub-app" placeholder="app" value={form.app} onChange={(event) => setForm({ ...form, app: event.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sub-source">Source</Label>
              <Input id="sub-source" placeholder="github" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sub-types">Event types</Label>
              <Input id="sub-types" placeholder="push, check_suite" value={form.eventTypes} onChange={(event) => setForm({ ...form, eventTypes: event.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sub-scopes">Scopes</Label>
              <Input id="sub-scopes" placeholder="org/app-one" value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} />
            </div>
            <Button disabled={subscribe.isPending || form.app === "" || form.source === ""} onClick={() => subscribe.mutate()}>Subscribe</Button>
          </div>
        </div>

        <Separator />
        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Recent deliveries</h4>
          {deliveries.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : deliveries.isSuccess && deliveries.data.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet.</p>
          ) : !deliveries.isSuccess ? null : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.deliveries.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell className="font-medium">{delivery.source}</TableCell>
                    <TableCell className="text-muted-foreground">{delivery.eventType}</TableCell>
                    <TableCell>
                      <Badge variant={delivery.status === "succeeded" ? "success" : delivery.status === "dead" || delivery.status === "failed" ? "destructive" : "secondary"}>
                        {delivery.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{delivery.attempts}</TableCell>
                    <TableCell className="text-muted-foreground">{delivery.lastError ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
