import { useCallback, useEffect, useState } from "react";
import { api, type AuditRow, type IntegrationView } from "./api";

const styles = {
  card: { border: "1px solid #c9c9c9", borderRadius: 8, padding: 16, marginTop: 16 } as const,
  button: { font: "inherit", padding: "4px 12px", borderRadius: 6, border: "1px solid #1c1c1e", background: "#fff", cursor: "pointer" } as const,
  input: { font: "inherit", padding: "4px 8px", borderRadius: 6, border: "1px solid #c9c9c9" } as const,
  muted: { color: "#6b6b6b", fontSize: 13 } as const,
  row: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" } as const,
  pre: { background: "#f4f4f4", padding: 12, borderRadius: 6, overflow: "auto", fontSize: 12 } as const,
};

export const IntegrationsPanel = () => {
  const [integrations, setIntegrations] = useState<Array<IntegrationView>>([]);
  const [grants, setGrants] = useState<Array<{ app: string; integration: string }>>([]);
  const [audit, setAudit] = useState<Array<AuditRow>>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", baseUrl: "", tokenEnv: "" });
  const [grantForm, setGrantForm] = useState({ integration: "", app: "" });

  const load = useCallback(async () => {
    try {
      const [listBody, grantsBody] = await Promise.all([
        api<{ integrations: Array<IntegrationView> }>("/integrations"),
        api<{ grants: Array<{ app: string; integration: string }> }>("/integrations/grants"),
      ]);
      setIntegrations(listBody.integrations);
      setGrants(grantsBody.grants);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    try {
      await api("/integrations", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", baseUrl: "", tokenEnv: "" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const grant = async () => {
    try {
      await api(`/integrations/${encodeURIComponent(grantForm.integration)}/grants`, {
        method: "POST",
        body: JSON.stringify({ app: grantForm.app }),
      });
      setGrantForm({ integration: "", app: "" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revoke = async (integration: string, app: string) => {
    try {
      await api(`/integrations/${encodeURIComponent(integration)}/grants/${encodeURIComponent(app)}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const showAudit = async (integration: string) => {
    try {
      const body = await api<{ audit: Array<AuditRow> }>(`/integrations/${encodeURIComponent(integration)}/audit`);
      setAudit(body.audit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div style={styles.card}>
      <h3 style={{ marginTop: 0 }}>Integrations (connection proxy)</h3>
      {error !== null && <p style={{ color: "#d33" }}>⚠ {error}</p>}

      {integrations.length === 0
        ? <p style={styles.muted}>No integrations registered.</p>
        : (
          <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #c9c9c9" }}>
                <th>name</th><th>base URL</th><th>token env</th><th>token?</th><th>grants</th><th></th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((integration) => (
                <tr key={integration.name} style={{ borderBottom: "1px solid #eee" }}>
                  <td><strong>{integration.name}</strong></td>
                  <td style={styles.muted}>{integration.baseUrl}</td>
                  <td style={styles.muted}>{integration.tokenEnv}</td>
                  <td>{integration.tokenConfigured ? "✓" : "✗ missing"}</td>
                  <td style={styles.muted}>
                    {grants.filter((g) => g.integration === integration.name).map((g) => (
                      <span key={g.app} style={{ marginRight: 8 }}>
                        {g.app}{" "}
                        <button style={styles.button} onClick={() => void revoke(g.integration, g.app)}>revoke</button>
                      </span>
                    ))}
                  </td>
                  <td><button style={styles.button} onClick={() => void showAudit(integration.name)}>audit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h4>Register integration</h4>
      <div style={styles.row}>
        <input style={styles.input} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={styles.input} placeholder="base URL" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        <input style={styles.input} placeholder="TOKEN_ENV_VAR" value={form.tokenEnv} onChange={(e) => setForm({ ...form, tokenEnv: e.target.value })} />
        <button style={styles.button} disabled={form.name === "" || form.baseUrl === "" || form.tokenEnv === ""} onClick={() => void create()}>
          Add
        </button>
      </div>

      <h4>Grant app access</h4>
      <div style={styles.row}>
        <input style={styles.input} placeholder="integration" value={grantForm.integration} onChange={(e) => setGrantForm({ ...grantForm, integration: e.target.value })} />
        <input style={styles.input} placeholder="app" value={grantForm.app} onChange={(e) => setGrantForm({ ...grantForm, app: e.target.value })} />
        <button style={styles.button} disabled={grantForm.integration === "" || grantForm.app === ""} onClick={() => void grant()}>
          Grant
        </button>
      </div>

      {audit.length > 0 && (
        <>
          <h4>Proxy audit</h4>
          <pre style={styles.pre}>{JSON.stringify(audit, null, 2)}</pre>
        </>
      )}
    </div>
  );
};
