import { createFileRoute } from "@tanstack/react-router";
import { OAuthConnections } from "../components/connections/oauth-connections";
import { ProxiedSecrets } from "../components/connections/proxied-secrets";
import { Webhooks } from "../components/connections/webhooks";

export const Route = createFileRoute("/connections")({ component: ConnectionsPage });

function ConnectionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <OAuthConnections />
      <ProxiedSecrets />
      <Webhooks />
    </div>
  );
}
