import { useEffect, useState, useRef, type FormEvent } from "react";

const TOKEN_KEY = "bs_auth_token";

export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function storeToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}

function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

async function attemptLogin(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      // Store the token from the response body in localStorage so every
      // subsequent API call can send it as a Bearer header — this bypasses
      // all browser third-party cookie restrictions inside iframes.
      if (data.token) storeToken(data.token);
      return { ok: true };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? "Invalid key" };
  } catch {
    return { ok: false, error: "Could not reach server" };
  }
}

async function checkAuth(): Promise<boolean> {
  const token = getStoredToken();
  if (token) {
    // Verify the stored token against a real auth-gated endpoint rather than
    // /api/health (which is exempt from auth and always returns 200).
    try {
      const res = await fetch("/api/auth/verify", {
        credentials: "include",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (res.ok) return true;
      clearToken();
    } catch {
      return false;
    }
  }

  // API_KEY is optional in development. Probe the login endpoint with an
  // empty key so the UI matches the server's open-auth configuration instead
  // of showing an unlock form that can never be submitted.
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.token) storeToken(data.token);
      return true;
    }
  } catch {
    // Keep the login form visible when the backend cannot be reached.
  }
  return false;
}

export function LoginGate({ children }: { children: React.ReactNode }) {
  // null = checking, true = authed, false = needs login
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkAuth().then(ok => setAuthed(ok ? true : false));
  }, []);

  useEffect(() => {
    const handler = () => { clearToken(); setAuthed(false); };
    window.addEventListener("auth:unauthorized", handler);
    return () => window.removeEventListener("auth:unauthorized", handler);
  }, []);

  useEffect(() => {
    if (authed === false) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [authed]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const key = inputRef.current?.value ?? "";
    if (!key) return;
    setLoading(true);
    setError(null);
    const result = await attemptLogin(key);
    setLoading(false);
    if (result.ok) {
      setAuthed(true);
    } else {
      setError(result.error ?? "Invalid key");
      if (inputRef.current) inputRef.current.value = "";
      inputRef.current?.focus();
    }
  }

  if (authed === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (authed === false) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-full max-w-sm mx-4">
          <div className="rounded-xl border border-border bg-card p-8 shadow-lg">
            <div className="flex items-center gap-3 mb-6">
              <img src="/favicon.png" alt="BharatScan" className="w-8 h-8" />
              <h1 className="text-xl font-semibold text-foreground">BharatScan</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Enter your API key to continue.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                ref={inputRef}
                type="password"
                placeholder="API key"
                autoComplete="current-password"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                disabled={loading}
              />
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? "Checking…" : "Unlock"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
