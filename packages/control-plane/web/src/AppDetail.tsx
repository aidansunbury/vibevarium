import { useCallback, useEffect, useState } from "react";
import { api, type AppRow, type DirectoryTool } from "./api";

const styles = {
  card: { border: "1px solid #c9c9c9", borderRadius: 8, padding: 16, marginTop: 16 } as const,
  button: { font: "inherit", padding: "4px 12px", borderRadius: 6, border: "1px solid #1c1c1e", background: "#fff", cursor: "pointer" } as const,
  danger: { font: "inherit", padding: "4px 12px", borderRadius: 6, border: "1px solid #d33", background: "#fff", color: "#d33", cursor: "pointer" } as const,
  muted: { color: "#6b6b6b", fontSize: 13 } as const,
  row: { display: "flex", gap: 12, alignItems: "center" } as const,
};

export const AppDetail = ({ name, onClose, onDeleted }: {
  readonly name: string;
  readonly onClose: () => void;
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
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        <div style={styles.row}>
          <button style={styles.danger} disabled={deleting} onClick={() => void remove()}>
            {deleting ? "Deleting…" : "Delete app"}
          </button>
          <button style={styles.button} onClick={onClose}>Close</button>
        </div>
      </div>
      {error !== null && <p style={{ color: "#d33" }}>⚠ {error}</p>}
      {app !== null && (
        <p style={styles.muted}>
          status {app.status} · url {app.url} · last seen {app.lastSeenAt ?? "never"}
          {app.lastError !== null && <> · last error {app.lastError}</>}
        </p>
      )}
      <h4>Tools ({tools.length})</h4>
      {tools.length === 0
        ? <p style={styles.muted}>No discovered tools — run discovery.</p>
        : (
          <ul>
            {tools.map((tool) => (
              <li key={tool.gatewayName}>
                <code>{tool.gatewayName}</code>{tool.stale && <span style={styles.muted}> (stale)</span>}
                {tool.descriptor.description !== undefined && <div style={styles.muted}>{tool.descriptor.description}</div>}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
};
