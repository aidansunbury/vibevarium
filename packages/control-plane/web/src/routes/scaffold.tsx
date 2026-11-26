import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import * as Schema from "effect/Schema";
import { api, type CapabilityStatus, type ProvisionStatus } from "../api";
import { Button } from "@vibevarium/ui/components/button";
import { Badge } from "@vibevarium/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Input } from "@vibevarium/ui/components/input";
import { Label } from "@vibevarium/ui/components/label";
import { Separator } from "@vibevarium/ui/components/separator";
import { toast } from "@vibevarium/ui/lib/toast";
import { Check, ChevronLeft, ChevronRight, Loader2, PlusIcon, X } from "lucide-react";

const ScaffoldSearch = Schema.Struct({ job: Schema.optional(Schema.String) });

export const Route = createFileRoute("/scaffold")({
  validateSearch: Schema.toStandardSchemaV1(ScaffoldSearch),
  component: ScaffoldWizard,
});

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STEPS = ["Name", "Target", "Storage", "Options", "Review"] as const;

type Target = "cloudflare" | "aws";
type Database = "cf-d1" | "planetscale-hyperdrive";

function ScaffoldWizard() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/scaffold" });
  const { job: jobId } = Route.useSearch();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [database, setDatabase] = useState<Database | null>(null);
  const [features, setFeatures] = useState<Array<"r2" | "hyperdrive">>([]);

  const options = useQuery({ queryKey: ["provisioning-options"], queryFn: api.provisioningOptions });
  const requirements = useQuery({
    queryKey: ["provisioning-requirements", name.trim()],
    queryFn: () => api.provisionRequirements(name.trim()),
    enabled: dnsLabel.test(name.trim()),
    staleTime: 0,
  });

  // Seed defaults once the capability report lands.
  useEffect(() => {
    if (options.data === undefined) return;
    if (target === null) setTarget(options.data.defaultTarget);
    if (database === null) setDatabase(options.data.defaultDatabase);
  }, [options.data, target, database]);

  const provisionStatus = useQuery({
    queryKey: ["provision", jobId],
    queryFn: () => api.provisionStatus(jobId!),
    enabled: jobId !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === "pending" || status === "running" ? 2_000 : false;
    },
  });

  // When the job finishes, refresh the apps + directory so the new app shows up.
  useEffect(() => {
    const status = provisionStatus.data?.status;
    if (status === "succeeded") {
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      void queryClient.invalidateQueries({ queryKey: ["directory"] });
    }
  }, [provisionStatus.data?.status, queryClient]);

  const submit = async () => {
    if (name.trim() === "" || target === null || database === null) return;
    try {
      const started = await api.provision({
        name: name.trim(),
        target,
        database,
        ...(features.length === 0 ? {} : { features }),
      });
      await navigate({ search: { job: started.jobId }, replace: true });
      toast.success(`Provisioning ${name.trim()}`);
    } catch (error) {
      toast.error(message(error));
    }
  };

  const reset = () => {
    setStep(0);
    setName("");
    void navigate({ search: {}, replace: true });
    setFeatures([]);
    setTarget(options.data?.defaultTarget ?? null);
    setDatabase(options.data?.defaultDatabase ?? null);
  };

  if (options.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading provisioning options…
        </CardContent>
      </Card>
    );
  }
  if (options.isError || options.data === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provision a new app</CardTitle>
          <CardDescription>Could not load provisioning options: {message(options.error)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const report = options.data;
  const nameValid = dnsLabel.test(name.trim());
  const requirementsValid = requirements.data?.available === true;

  // A job in flight takes over the whole card with the live stepper.
  if (jobId !== undefined) {
    return (
      <ProvisioningRun
        status={provisionStatus.data}
        isLoading={provisionStatus.isLoading}
        error={provisionStatus.error}
        onRetry={() => void provisionStatus.refetch()}
        onDone={reset}
      />
    );
  }

  const canNext =
    step === 0 ? nameValid && requirementsValid : step === 1 ? target !== null : step === 2 ? database !== null : true;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlusIcon className="size-5 text-muted-foreground" />
          Provision a new app
        </CardTitle>
        <CardDescription>
          Repo, deploy, domain, OIDC client, and discovery — wired from the platform capability
          config. Only options the platform can actually back are offered.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Stepper steps={STEPS} current={step} />
        <Separator />

        {step === 0 && (
          <div className="grid gap-2">
            <Label htmlFor="app-name">App name</Label>
            <Input
              id="app-name"
              autoFocus
              placeholder="app-name (lower-kebab)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              DNS-label-safe: lowercase letters, digits, dashes. Becomes{" "}
              <code>{name.trim() !== "" && nameValid ? `${name.trim()}.<domain>` : "<name>.<domain>"}</code>
            </p>
            {name.trim() !== "" && !nameValid && (
              <p className="text-xs text-destructive">Invalid name — lower-kebab-case, 1–63 chars.</p>
            )}
            {nameValid && requirements.isFetching && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Verifying requirements…</p>
            )}
            {nameValid && requirements.isError && (
              <p className="text-xs text-destructive">Could not verify requirements: {message(requirements.error)}</p>
            )}
            {requirements.data !== undefined && (
              <ul className="mt-2 grid gap-1 rounded-md border p-3">
                {requirements.data.checks.map((check) => (
                  <li key={check.id} className={`flex items-center gap-2 text-xs ${check.available ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                    {check.available ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                    <span className="font-medium">{check.label}:</span> {check.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 1 && (
          <OptionGrid
            legend="Deployment target"
            options={([
              {
                value: "cloudflare" as const,
                title: "Cloudflare",
                blurb: "Workers + D1 + custom domain. The default — this app style fits Workers best.",
                cap: report.deployTargets.cloudflare,
                recommended: true,
              },
              {
                value: "aws" as const,
                title: "AWS",
                blurb: "Lambda target. Demonstrates the platform is deploy-agnostic.",
                cap: report.deployTargets.aws,
              },
            ])}
            selected={target}
            onSelect={(value) => setTarget(value)}
          />
        )}

        {step === 2 && (
          <OptionGrid
            legend="Storage / database"
            options={([
              {
                value: "cf-d1" as const,
                title: "Cloudflare D1",
                blurb: "Per-app D1 database created with the Worker. The default.",
                cap: report.database["cf-d1"],
                recommended: true,
              },
              {
                value: "planetscale-hyperdrive" as const,
                title: "PlanetScale (Hyperdrive)",
                blurb: "External PlanetScale Postgres via a Cloudflare Hyperdrive connection.",
                cap: report.database["planetscale-hyperdrive"],
              },
            ])}
            selected={database}
            onSelect={(value) => setDatabase(value)}
          />
        )}

        {step === 3 && (
          <div className="grid gap-3">
            <Label>Options</Label>
            <FeatureToggle
              title="R2 bucket"
              blurb="Attach a per-app R2 object-storage bucket."
              cap={report.features.r2}
              checked={features.includes("r2")}
              onChange={(checked) =>
                setFeatures((current) => (checked ? [...current, "r2"] : current.filter((f) => f !== "r2")))
              }
            />
            <FeatureToggle
              title="Hyperdrive connection"
              blurb="Attach a Cloudflare Hyperdrive connection (e.g. to PlanetScale)."
              cap={report.features.hyperdrive}
              checked={features.includes("hyperdrive")}
              onChange={(checked) =>
                setFeatures((current) =>
                  checked ? [...current, "hyperdrive"] : current.filter((f) => f !== "hyperdrive"),
                )
              }
            />
            {!report.features.r2.enabled && !report.features.hyperdrive.enabled && (
              <p className="text-xs text-muted-foreground">
                No optional features are enabled in the platform config. Set TERRARIUM_FEATURES to
                offer more.
              </p>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="grid gap-2 text-sm">
            <ReviewRow label="App name" value={name.trim()} />
            <ReviewRow label="Target" value={target ?? ""} />
            <ReviewRow label="Database" value={database ?? ""} />
            <ReviewRow label="Features" value={features.length === 0 ? "none" : features.join(", ")} />
            <p className="mt-2 text-xs text-muted-foreground">
              Submitting starts an async provisioning job — you can watch each step complete.
            </p>
          </div>
        )}

        <Separator />
        <div className="flex items-center justify-between">
          <Button variant="outline" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            <ChevronLeft className="size-4" /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button disabled={!canNext} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              Next <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button disabled={!nameValid || !requirementsValid || target === null || database === null} onClick={() => void submit()}>
              Provision app
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --- pieces -----------------------------------------------------------------

function Stepper({ steps, current }: { steps: ReadonlyArray<string>; current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
              index < current
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : index === current
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {index < current ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span className={`text-sm ${index === current ? "text-foreground" : "text-muted-foreground"}`}>
            {label}
          </span>
          {index < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

interface Choice {
  readonly value: string;
  readonly title: string;
  readonly blurb: string;
  readonly cap: CapabilityStatus;
  readonly recommended?: boolean;
}

function OptionGrid<T extends string>({
  legend,
  options,
  selected,
  onSelect,
}: {
  legend: string;
  options: ReadonlyArray<Choice & { value: T }>;
  selected: T | null;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="grid gap-3">
      <Label>{legend}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const usable = option.cap.enabled && option.cap.credentialsValid;
          return (
            <button
              key={option.value}
              type="button"
              disabled={!usable}
              onClick={() => onSelect(option.value)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                selected === option.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-foreground/30"
              } ${usable ? "" : "cursor-not-allowed opacity-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{option.title}</span>
                <span className="flex gap-1">
                  {option.recommended === true && <Badge variant="secondary">default</Badge>}
                  {!option.cap.enabled ? (
                    <Badge variant="outline">not enabled</Badge>
                  ) : !option.cap.credentialsValid ? (
                    <Badge variant="destructive">missing creds</Badge>
                  ) : null}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{option.blurb}</p>
              {!usable && option.cap.missing.length > 0 && (
                <p className="mt-2 text-xs text-destructive">
                  Missing: {option.cap.missing.join(", ")}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FeatureToggle({
  title,
  blurb,
  cap,
  checked,
  onChange,
}: {
  title: string;
  blurb: string;
  cap: CapabilityStatus;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const usable = cap.enabled && cap.credentialsValid;
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border p-4 transition-colors ${
        usable ? "cursor-pointer hover:border-foreground/30" : "cursor-not-allowed opacity-50"
      } ${checked ? "border-primary bg-primary/5" : "border-border"}`}
    >
      <input
        type="checkbox"
        className="mt-1 size-4 accent-primary"
        disabled={!usable}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium">{title}</span>
          {!cap.enabled ? (
            <Badge variant="outline">not enabled</Badge>
          ) : !cap.credentialsValid ? (
            <Badge variant="destructive">missing creds</Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{blurb}</span>
        {!usable && cap.missing.length > 0 && (
          <span className="mt-1 block text-xs text-destructive">Missing: {cap.missing.join(", ")}</span>
        )}
      </span>
    </label>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ProvisioningRun({
  status,
  isLoading,
  error,
  onRetry,
  onDone,
}: {
  status: ProvisionStatus | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onDone: () => void;
}) {
  const failed = status?.status === "failed" || status?.status === "dead";
  const finished = status?.status === "succeeded" || failed;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {status?.status === "succeeded" ? (
            <Badge variant="success">provisioned</Badge>
          ) : failed ? (
            <Badge variant="destructive">failed</Badge>
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          Provisioning {status?.name ?? "app"}
        </CardTitle>
        <CardDescription>
          {isLoading || status === undefined
            ? "Starting the job…"
            : status.status === "pending"
              ? "The job is queued and will start shortly."
              : status.status === "running"
              ? "The job is running — each step flips as it completes."
              : failed
                ? (status.error ?? "The provisioning job failed.")
                : "All steps completed."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="grid gap-2">
          {(status?.steps ?? []).map((step) => (
            <li key={step.id} className="flex items-center gap-3 text-sm">
              <span
                className={`flex size-5 items-center justify-center rounded-full ${
                  step.state === "done"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : step.state === "failed"
                      ? "bg-destructive/15 text-destructive"
                      : step.state === "running"
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground"
                }`}
              >
                {step.state === "done" ? (
                  <Check className="size-3" />
                ) : step.state === "failed" ? (
                  <X className="size-3" />
                ) : step.state === "running" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className={step.state === "pending" ? "text-muted-foreground" : ""}>{step.label}</span>
              {step.detail !== undefined && (
                <span className="ml-auto truncate text-xs text-muted-foreground">{step.detail}</span>
              )}
            </li>
          ))}
        </ol>

        {error !== null && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <span>Could not refresh this job: {message(error)}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        )}

        {status?.status === "succeeded" && status.result !== undefined && (
          <div className="rounded-md bg-muted p-3 text-xs">
            <ReviewRow label="URL" value={String(status.result.url ?? "")} />
            <ReviewRow label="Repo" value={String(status.result.repoUrl ?? "")} />
          </div>
        )}

        {finished && (
          <div className="flex justify-end">
            <Button onClick={onDone}>Provision another app</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
