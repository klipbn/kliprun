import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { StatsFilters, UsageInterval, UsageObservation } from "@shared/usage";
import { buildDashboard, buildSessionDetail, rankSessions } from "./aggregate";
import { UsageImporter } from "./importer";
import { UsageStore } from "./store";
import type { StatsOptions } from "./service";

const scope = globalThis as unknown as { onmessage: (event: { data: { id?: number; op: string; data: unknown } }) => void; postMessage: (data: unknown) => void };
let store: UsageStore | null = null;
let importer: UsageImporter | null = null;
let importRun: Promise<unknown> | null = null;
let timer: Timer | null = null;
let closing = false;
async function importHistory(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const db = new Database(path, { readonly: true });
  try {
    const last = db.query<{ value: number }, []>("SELECT value FROM history_metadata WHERE key='last_observed_at' LIMIT 1").get()?.value ?? 0;
    let cursor = 0;
    while (!closing) {
      const rows = db.query<UsageInterval, [number]>("SELECT * FROM status_intervals WHERE id>? ORDER BY id LIMIT 500").all(cursor);
      store!.importIntervals(rows, last);
      if (rows.length < 500) break;
      cursor = rows[rows.length - 1].id;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { db.close(); }
}
function refresh(): void {
  if (!importer || closing) return;
  importRun = importer.runOnce().then(status => store?.setCheckpoint("sources", status)).catch(() => {
    // Source errors are normally reported individually by the importer.
  }).finally(() => { if (!closing) timer = setTimeout(refresh, 30000); });
}
scope.onmessage = event => {
  const { id, op, data } = event.data;
  const reply = (result: unknown) => { if (id !== undefined) scope.postMessage({ id, result }); };
  void (async () => {
    if (op === "init") {
      const options = data as StatsOptions;
      store = new UsageStore(options.path);
      await importHistory(options.historyPath);
      importer = new UsageImporter({ opencodePath: options.opencodePath, codexHome: options.codexHome, onProgress: status => store?.setCheckpoint("sources", status) }, store);
      store.setCheckpoint("sources", importer.status);
      refresh(); reply(true); return;
    }
    if (!store) throw new Error("Statistics index not initialized");
    if (op === "observe") { store.observe(data as UsageObservation); return; }
    if (op === "close") {
      closing = true;
      if (timer) clearTimeout(timer);
      importer?.stop();
      await importRun;
      store.close(); store = null; reply(true); return;
    }
    const request = data as { filters: StatsFilters; sessionId: string; sort: string; page: number; limit: number };
    const dataset = store.dataset();
    if (op === "dashboard") reply(buildDashboard(dataset, request.filters));
    else if (op === "sessions") reply(rankSessions(dataset, request.filters, request.sort, request.page, request.limit));
    else if (op === "detail") reply(buildSessionDetail(dataset, request.filters, request.sessionId));
    else throw new Error("Unknown statistics request");
  })().catch(() => { if (id !== undefined) scope.postMessage({ id, error: "Statistics operation failed" }); });
};
