import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stage = process.env.ALCHEMY_STAGE ?? "live_aidan";
const stack = process.env.ALCHEMY_STACK_NAME ?? "VibevariumEcs";
const config = process.env.ALCHEMY_CONFIG ?? "packages/infra/src/main-ecs.ts";
const alchemy = process.env.ALCHEMY_BIN ?? "packages/infra/node_modules/alchemy/bin/alchemy.js";

const run = async (file: string, args: string[], timeout = 120_000) => {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error: any) {
    const safeArgs = args.map((arg, index) => args[index - 1] === "--secret-string" ? "<redacted>" : arg);
    throw new Error(`${file} ${safeArgs.join(" ")} failed: ${error?.stderr ?? error?.message ?? error}`);
  }
};
const aws = (args: string[], timeout?: number) => run("aws", args, timeout);

const resource = async (id: string) => {
  const output = await run(process.execPath, [
    alchemy, "state", "read", `${stack}/${stage}/${id}`, "--config", config,
  ]);
  const record = JSON.parse(output);
  return record.attr ?? record;
};

const clusterArn = (await resource("Cluster")).clusterArn as string;
const task = await resource("DatabaseInitTask");
const postgres = await resource("Postgres");
const tasksSg = (await resource("TasksSg")).groupId as string;
const subnetIds = [
  (await resource("Network/PublicSubnet1")).subnetId,
  (await resource("Network/PublicSubnet2")).subnetId,
] as string[];

const sql = [
  "for db in control_plane casdoor; do",
  "  psql -v ON_ERROR_STOP=1 -tc \"SELECT 1 FROM pg_database WHERE datname='$db'\" | grep -q 1 ||",
  "  psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $db\";",
  "done",
].join(" ");

console.log("Creating control_plane and casdoor databases idempotently…");
const started = JSON.parse(await aws([
  "ecs", "run-task",
  "--cluster", clusterArn,
  "--task-definition", task.taskDefinitionArn,
  "--launch-type", "FARGATE",
  "--network-configuration", JSON.stringify({
    awsvpcConfiguration: {
      subnets: subnetIds,
      securityGroups: [tasksSg],
      assignPublicIp: "ENABLED",
    },
  }),
  "--overrides", JSON.stringify({
    containerOverrides: [{ name: task.containerName, command: ["sh", "-c", sql] }],
  }),
  "--query", "tasks[0].taskArn",
  "--output", "json",
]));
if (!started || started.startsWith("arn:") === false) {
  throw new Error(`Could not start database initialization task: ${JSON.stringify(started)}`);
}
await aws(["ecs", "wait", "tasks-stopped", "--cluster", clusterArn, "--tasks", started], 600_000);
const taskResult = JSON.parse(await aws([
  "ecs", "describe-tasks", "--cluster", clusterArn, "--tasks", started, "--output", "json",
]));
const exitCode = taskResult.tasks[0]?.containers?.[0]?.exitCode;
if (exitCode !== 0) {
  const reason = taskResult.tasks[0]?.containers?.[0]?.reason ?? taskResult.tasks[0]?.stoppedReason;
  throw new Error(`Database initialization exited with ${exitCode ?? "unknown"}: ${reason ?? "no reason"}`);
}

console.log("Writing database DSN secrets…");
const master = JSON.parse(await aws([
  "secretsmanager", "get-secret-value",
  "--secret-id", postgres.masterUserSecretArn,
  "--query", "SecretString", "--output", "text",
]));
const credentials = typeof master === "string" ? JSON.parse(master) : master;
const endpoint = postgres.endpointAddress;
const dsn = (database: string) =>
  `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${endpoint}:5432/${database}?sslmode=require`;

let dsnChanged = false;
for (const [name, database] of [
  ["/vibevarium/prod/ECS_DATABASE_URL", "control_plane"],
  ["/vibevarium/prod/ECS_CASDOOR_DATABASE_URL", "casdoor"],
] as const) {
  const desired = dsn(database);
  const current = await aws([
    "secretsmanager", "get-secret-value", "--secret-id", name,
    "--query", "SecretString", "--output", "text",
  ]).catch(() => "");
  if (current !== desired) {
    dsnChanged = true;
    await aws([
      "secretsmanager", "put-secret-value", "--secret-id", name,
      "--secret-string", desired,
    ]);
  }
}

const serviceArn = async (id: string) => {
  const state = await resource(id);
  if (state.serviceArn) return state.serviceArn as string;
  const services = JSON.parse(await aws([
    "ecs", "list-services", "--cluster", clusterArn, "--output", "json",
  ]));
  const match = services.serviceArns.find((arn: string) =>
    arn.toLowerCase().includes(id.toLowerCase()),
  );
  if (!match) throw new Error(`Could not find ECS service for ${id}`);
  return match as string;
};

const serviceNeedsRestart = async (id: string) => {
  const arn = await serviceArn(id);
  const result = JSON.parse(await aws([
    "ecs", "describe-services", "--cluster", clusterArn,
    "--services", arn, "--output", "json",
  ]));
  const service = result.services[0];
  return service.runningCount < service.desiredCount ||
    service.deployments.some((deployment: any) =>
      deployment.status === "PRIMARY" && deployment.rolloutState !== "COMPLETED",
    );
};

if (dsnChanged || await serviceNeedsRestart("CasdoorService") || await serviceNeedsRestart("ControlPlaneService")) {
  for (const id of ["CasdoorService", "ControlPlaneService"]) {
    const arn = await serviceArn(id);
    console.log(`Restarting ${id} with the current DSN…`);
    await aws([
      "ecs", "update-service", "--cluster", clusterArn,
      "--service", arn, "--force-new-deployment",
    ]);
  }

  await aws([
    "ecs", "wait", "services-stable", "--cluster", clusterArn,
    "--services",
    await serviceArn("CasdoorService"),
    await serviceArn("ControlPlaneService"),
  ], 600_000);
} else {
  console.log("Database DSNs are unchanged; no service restart is needed.");
}

console.log("Database initialization and ECS service rollout completed.");
