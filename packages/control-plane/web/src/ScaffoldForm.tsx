import { useState } from "react";
import { api } from "./api";

const styles = {
  card: { border: "1px solid #c9c9c9", borderRadius: 8, padding: 16, marginTop: 16 } as const,
  button: { font: "inherit", padding: "4px 12px", borderRadius: 6, border: "1px solid #1c1c1e", background: "#fff", cursor: "pointer" } as const,
  input: { font: "inherit", padding: "4px 8px", borderRadius: 6, border: "1px solid #c9c9c9" } as const,
  muted: { color: "#6b6b6b", fontSize: 13 } as const,
  row: { display: "flex", gap: 12, alignItems: "center" } as const,
  pre: { background: "#f4f4f4", padding: 12, borderRadius: 6, overflow: "auto", fontSize: 12 } as const,
};

export const ScaffoldForm = ({ onScaffolded }: { readonly onScaffolded: () => void }) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const created = await api("/scaffold", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setResult(created);
      setName("");
      onScaffolded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.card}>
      <h3 style={{ marginTop: 0 }}>Scaffold a new app</h3>
      <div style={styles.row}>
        <input
          style={styles.input}
          placeholder="app-name (lower-kebab)"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !busy && name.trim() !== "" && void submit()}
        />
        <button style={styles.button} disabled={busy || name.trim() === ""} onClick={() => void submit()}>
          {busy ? "Scaffolding…" : "Scaffold"}
        </button>
      </div>
      <p style={styles.muted}>POST /scaffold — creates the repo, boots the app, registers it, and runs discovery.</p>
      {error !== null && <p style={{ color: "#d33" }}>⚠ {error}</p>}
      {result !== null && <pre style={styles.pre}>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
};
