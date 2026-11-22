import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type AuthStatus, type TicketSummary, type WhoAmI } from "./client";

type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message}${typeof error.body === "string" ? `: ${error.body}` : ""}`
    : error instanceof Error
      ? error.message
      : String(error);

export const App = () => {
  const [tickets, setTickets] = useState<LoadState<readonly TicketSummary[]>>({ status: "loading" });
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setTickets({ status: "loading" });
    try {
      const list = await api.listTickets();
      setTickets({ status: "ready", value: list.tickets });
    } catch (error) {
      setTickets({ status: "error", message: errorMessage(error) });
    }
  }, []);

  const refreshWhoami = useCallback(async () => {
    try {
      setWhoami(await api.whoami());
    } catch {
      setWhoami(null);
    }
  }, []);

  useEffect(() => {
    api.authStatus().then(setAuthStatus, () => setAuthStatus({ enabled: false }));
    void refresh();
    void refreshWhoami();
  }, [refresh, refreshWhoami]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await refresh();
        await refreshWhoami();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshWhoami],
  );

  const onOpenTicket = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const title = field("title");
    const reporter = field("reporter");
    if (title.length === 0 || reporter.length === 0) return;
    event.currentTarget.reset();
    void runAction(async () => {
      const receipt = await api.openTicket({ title, reporter });
      // Read the list back at the command's version: read-your-write, no sleep.
      const list = await api.listTicketsAtLeast(receipt);
      setTickets({ status: "ready", value: list.tickets });
    });
  };

  const onCloseTicket = (id: string) =>
    void runAction(async () => {
      const receipt = await api.closeTicket(id);
      const list = await api.listTicketsAtLeast(receipt);
      setTickets({ status: "ready", value: list.tickets });
    });

  const onDevLogin = () =>
    void runAction(async () => {
      if (authStatus?.issuer === undefined) {
        throw new Error("The worker did not report an issuer");
      }
      await api.devLogin(authStatus.issuer, {
        sub: "user-ada",
        name: "Ada",
        audience: `${window.location.hostname}.terrarium.local`,
      });
    });

  const onLogout = () =>
    void runAction(async () => {
      setToken(null);
    });

  const loggedIn = getToken() !== null;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Tickets</h1>
      <p style={{ color: "#666" }}>
        React SPA served by the same Cloudflare Worker that hosts the Tickets domain on Durable Objects.
      </p>

      <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Session</h2>
        {authStatus === null ? (
          <p>Checking auth…</p>
        ) : authStatus.enabled ? (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            {loggedIn ? (
              <>
                <span>
                  Signed in{whoami?.actor?.name !== undefined ? ` as ${whoami.actor.name}` : ""}
                  {whoami?.actor != null ? ` (${whoami.actor.sub})` : ""}
                </span>
                <button type="button" disabled={busy} onClick={onLogout}>
                  Log out
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={onDevLogin}>
                Login (dev)
              </button>
            )}
          </div>
        ) : (
          <p style={{ color: "#666" }}>Auth is off (no TERRARIUM_ISSUER configured).</p>
        )}
        {whoami !== null && authStatus?.enabled === true && (
          <pre style={{ background: "#f6f6f6", padding: "0.5rem", borderRadius: 4, overflow: "auto" }}>
            {JSON.stringify(whoami, null, 2)}
          </pre>
        )}
      </section>

      <form onSubmit={onOpenTicket} style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <input name="title" placeholder="What's broken?" required style={{ flex: 2, padding: "0.4rem" }} />
        <input name="reporter" placeholder="Reporter" required style={{ flex: 1, padding: "0.4rem" }} />
        <button type="submit" disabled={busy}>
          Open ticket
        </button>
      </form>

      {actionError !== null && <p style={{ color: "#b00" }}>{actionError}</p>}

      {tickets.status === "loading" && <p>Loading tickets…</p>}
      {tickets.status === "error" && <p style={{ color: "#b00" }}>Could not load tickets: {tickets.message}</p>}
      {tickets.status === "ready" &&
        (tickets.value.length === 0 ? (
          <p style={{ color: "#666" }}>No tickets yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
            {tickets.value.map((ticket) => (
              <li
                key={ticket.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                }}
              >
                <div>
                  <strong>{ticket.title}</strong>
                  <div style={{ color: "#666", fontSize: "0.85rem" }}>
                    {ticket.id} · reported by {ticket.reporter} ·{" "}
                    <span style={{ color: ticket.status === "open" ? "#080" : "#666" }}>{ticket.status}</span>
                  </div>
                </div>
                {ticket.status === "open" && (
                  <button type="button" disabled={busy} onClick={() => onCloseTicket(ticket.id)}>
                    Close
                  </button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </main>
  );
};
