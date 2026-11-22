import { useCallback, useEffect, useState } from "react";
import { api, login, logout, type Actor, type AppRow } from "./api";
import { AppDetail } from "./AppDetail";
import { ScaffoldForm } from "./ScaffoldForm";
import { IntegrationsPanel } from "./IntegrationsPanel";

const styles = {
  shell: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", margin: "0 auto", maxWidth: 960, padding: "24px 16px", color: "#1c1c1e" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #1c1c1e", paddingBottom: 8 } as const,
  badge: (status: AppRow["status"]) => ({
    display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 12,
    background: status === "up" ? "#c8f7c5" : status === "down" ? "#f7c5c5" : "#e2e2e2",
  }),
  card: { border: "1px solid #c9c9c9", borderRadius: 8, padding: 16, marginTop: 16 } as const,
  button: { font: "inherit", padding: "4px 12px", borderRadius: 6, border: "1px solid #1c1c1e", background: "#fff", cursor: "pointer" } as const,
  row: { display: "flex", gap: 12, alignItems: "center" } as const,
  muted: { color: "#6b6b6b", fontSize: 13 } as const,
};

export const App = () => {
  const [actor, setActor] = useState<Actor | null>(null);
  const [authOn, setAuthOn] = useState<boolean | null>(null);
  const [apps, setApps] = useState<Array<AppRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ actor: Actor | null; auth: "on" | "off" }>("/auth/me");
      setActor(me.actor);
      setAuthOn(me.auth === "on");
      const appsBody = await api<{ apps: Array<AppRow> }>("/apps");
      setApps(appsBody.apps);
      setError(null);
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && (cause as { status: number }).status === 401) {
        setActor(null);
        setAuthOn(true);
        setError(null);
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  const signedOut = authOn === true && actor === null;

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <strong>Terrarium control plane</strong>{" "}
          <span style={styles.muted}>app gallery</span>
        </div>
        <div style={styles.row}>
          {actor !== null && <span style={styles.muted}>{actor.name ?? actor.sub} ({actor.sub})</span>}
          {authOn === false && <span style={styles.muted}>auth off</span>}
          {signedOut
            ? <button style={styles.button} onClick={() => login()}>Log in</button>
            : authOn === true && <button style={styles.button} onClick={() => void logout()}>Log out</button>}
        </div>
      </header>

      {error !== null && <div style={{ ...styles.card, borderColor: "#d33" }}>⚠ {error}</div>}

      {signedOut
        ? <div style={styles.card}>This control plane requires sign-in. Use the login button to authenticate with Logto.</div>
        : (
          <>
            <div style={styles.card}>
              <h3 style={{ marginTop: 0 }}>Registered apps</h3>
              {apps === null
                ? <p style={styles.muted}>Loading…</p>
                : apps.length === 0
                  ? <p style={styles.muted}>No apps registered. Scaffold one below.</p>
                  : (
                    <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #c9c9c9" }}>
                          <th>name</th><th>status</th><th>url</th><th>last seen</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {apps.map((app) => (
                          <tr key={app.name} style={{ borderBottom: "1px solid #eee" }}>
                            <td><strong>{app.name}</strong></td>
                            <td><span style={styles.badge(app.status)}>{app.status}</span></td>
                            <td style={styles.muted}>{app.url}</td>
                            <td style={styles.muted}>{app.lastSeenAt ?? "never"}</td>
                            <td><button style={styles.button} onClick={() => setSelected(app.name)}>details</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              <div style={{ ...styles.row, marginTop: 12 }}>
                <button style={styles.button} onClick={() => setRefreshTick((n) => n + 1)}>Refresh</button>
                <button
                  style={styles.button}
                  onClick={() => void api("/discover", { method: "POST", body: "{}" }).then(() => setRefreshTick((n) => n + 1))}
                >
                  Run discovery
                </button>
              </div>
            </div>

            {selected !== null && (
              <AppDetail
                name={selected}
                onClose={() => setSelected(null)}
                onDeleted={() => { setSelected(null); setRefreshTick((n) => n + 1); }}
              />
            )}

            <ScaffoldForm onScaffolded={() => setRefreshTick((n) => n + 1)} />
            <IntegrationsPanel />
          </>
        )}
    </div>
  );
};
