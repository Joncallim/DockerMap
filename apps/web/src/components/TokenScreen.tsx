import { FormEvent, useState } from "react";
import { apiUrl } from "../utils/api";

interface TokenScreenProps {
  onAuthenticated: () => void;
}

export default function TokenScreen({ onAuthenticated }: TokenScreenProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/auth/session"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      if (!response.ok) {
        setError("That token was not accepted.");
        return;
      }
      setToken("");
      onAuthenticated();
    } catch {
      setError("Could not reach DockerMap.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="token-title">
        <div className="eyebrow">DockerMap</div>
        <h1 id="token-title">Enter your API token</h1>
        <p className="muted-line">This token is exchanged for a short-lived, HttpOnly browser session.</p>
        <form onSubmit={submit}>
          <label htmlFor="dockermap-api-token">API token</label>
          <input
            id="dockermap-api-token"
            name="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
          <button type="submit" disabled={submitting}>{submitting ? "Connecting…" : "Connect"}</button>
        </form>
        {error && <p role="alert" className="auth-error">{error}</p>}
      </section>
    </main>
  );
}
