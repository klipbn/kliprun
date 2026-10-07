import { useEffect, useState } from "react";

export function useStatsRequest<T>(url: string | null, refresh: number) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let controller: AbortController | null = null;
    setData(null);
    setError(null);
    if (!url) { setPending(false); return; }
    async function load() {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      setPending(true);
      try {
        const response = await fetch(url!, { signal: requestController.signal });
        if (!response.ok) throw new Error(`Unable to load statistics (${response.status})`);
        const result = await response.json() as T;
        if (live && controller === requestController) { setData(result); setError(null); }
      } catch (err) {
        if (live && controller === requestController && !(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : "Unable to load statistics");
      } finally { if (live && controller === requestController && !requestController.signal.aborted) setPending(false); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { live = false; controller?.abort(); window.clearInterval(timer); };
  }, [url, refresh]);
  return { data, pending, error };
}
