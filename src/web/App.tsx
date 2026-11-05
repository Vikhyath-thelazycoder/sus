import { useEffect, useState } from "react";

type Status = "checking" | "online" | "offline";

/** P1 shell: brand, a placeholder input and an API health indicator. The real chat UI arrives in P5. */
export function App() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => setStatus(r.ok ? "online" : "offline"))
      .catch(() => setStatus("offline"));
  }, []);

  return (
    <main className="min-h-dvh bg-bg text-text flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[720px] text-center">
        <p className="text-sm tracking-wide text-muted">SustainIQ</p>
        <h1 className="mt-3 text-3xl font-semibold">What would you like to research?</h1>
        <p className="mt-2 text-muted">
          Answers from research papers on sustainable materials, with citations.
        </p>
        <label htmlFor="q" className="sr-only">
          Your question
        </label>
        <input
          id="q"
          disabled
          placeholder="Ask about biomaterials, green chemistry or packaging…"
          className="mt-8 w-full rounded-xl border border-border bg-surface px-4 py-3 text-base placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
        />
        <p className="mt-6 text-sm text-muted" aria-live="polite">
          Service status: <span className={status === "online" ? "text-accent" : ""}>{status}</span>
        </p>
      </div>
    </main>
  );
}
