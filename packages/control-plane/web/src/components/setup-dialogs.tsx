import { useState } from "react";
import { API_ORIGIN } from "../api";
import { Button } from "@vibevarium/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@vibevarium/ui/components/dialog";
import { CheckIcon, CopyIcon, PlugIcon, TerminalIcon } from "@vibevarium/ui/lib/icons";
import { toast } from "@vibevarium/ui/lib/toast";

const CLI_INSTALL_CMD = "curl -fsSL https://github.com/aidansunbury/vibevarium/releases/latest/download/install.sh | sh";
const CLI_LOGIN_CMD = "vibevarium login\nvibevarium whoami";

const getMcpUrl = (): string => {
  const origin = (API_ORIGIN || globalThis.location?.origin || "https://api.vibevarium.com").replace(/\/+$/, "");
  return `${origin}/mcp`;
};

function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label !== undefined && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      <div className="relative rounded-md border bg-muted/50 p-3 pr-10 font-mono text-xs leading-relaxed">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void handleCopy()}
          className="absolute top-2 right-2"
          aria-label="Copy snippet"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

export function CliInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalIcon className="size-4 text-muted-foreground" />
            Install the CLI
          </DialogTitle>
          <DialogDescription>
            Download and install the <code className="rounded bg-muted px-1 py-0.5 text-xs">vibevarium</code> binary
            for macOS or Linux, then sign in with your platform account.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <CopyBlock label="1. Download and install" code={CLI_INSTALL_CMD} />
          <CopyBlock label="2. Sign in and verify" code={CLI_LOGIN_CMD} />
          <p className="text-xs text-muted-foreground">
            Supports macOS (arm64, x64) and Linux (x64). If the repository is private, install the{" "}
            <code className="rounded bg-muted px-1 py-0.5">gh</code> CLI and run{" "}
            <code className="rounded bg-muted px-1 py-0.5">gh auth login</code> first.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function McpConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mcpUrl = getMcpUrl();
  const claudeCodeCmd = `claude mcp add --transport http vibevarium ${mcpUrl}`;
  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        vibevarium: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugIcon className="size-4 text-muted-foreground" />
            Connect to MCP
          </DialogTitle>
          <DialogDescription>
            Connect your AI client to the platform meta-MCP gateway to access every app&apos;s tools through one
            endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <CopyBlock label="MCP endpoint URL" code={mcpUrl} />
          <CopyBlock label="Claude Code" code={claudeCodeCmd} />
          <CopyBlock label="Cursor / MCP JSON config" code={jsonConfig} />
          <p className="text-xs text-muted-foreground">
            Authentication uses OAuth automatically — your MCP client will prompt you to sign in through your browser on
            first connect.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
