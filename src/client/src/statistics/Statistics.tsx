import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, ArrowUpRight, BarChart3, CalendarDays, ChevronLeft, ChevronRight, CircleHelp, Cpu, Layers3, Loader2, MessageSquare, RefreshCw, Timer } from "lucide-react";
import type { StatsBreakdown, StatsDashboardPayload, StatsFilters, StatsSessionsPayload, UsageMetrics } from "@shared/usage";
import { calendarPeriod, parseFilters, refreshRelativeFilters, serializeFilters, toggleValue, type Preset } from "./filters";
import { cacheShare, compare, count, dateLabel, duration, percent, projectName, readable, sourceName, tokens } from "./format";
import { FilterBar, PRESETS } from "./FilterBar";
import { Heatmap, Scatter, SeriesChart } from "./Charts";
import { TaskDetail } from "./TaskDetail";
import { useStatsRequest } from "./useStatsRequest";
import "./statistics.css";

type Sort = "running" | "tokens" | "turns";
type Dimension = "source" | "agent" | "model" | "project";
const DIMENSIONS: Array<{ key: Dimension; label: string; field: "sources" | "agents" | "models" | "projects" }> = [
  { key: "source", label: "Sources", field: "sources" }, { key: "agent", label: "Agents", field: "agents" }, { key: "model", label: "Models", field: "models" }, { key: "project", label: "Projects", field: "projects" },
];
function initialPreset(): Preset {
  const search = new URLSearchParams(window.location.search), preset = search.get("period");
  return PRESETS.some((p) => p.key === preset) ? preset as Preset : search.get("from") === "0" ? "all" : search.has("from") ? "custom" : "7";
}
function initialSort(): Sort { const sort = new URLSearchParams(window.location.search).get("sort"); return sort === "tokens" || sort === "turns" ? sort : "running"; }
function initialPage(): number { const value = Number(new URLSearchParams(window.location.search).get("page")); return Number.isInteger(value) && value > 0 ? value : 1; }
function Metric({ label, value, previous, icon: Icon, note, exact, partial, allHistory }: { label: string; value: string; previous: string; icon: typeof Cpu; note: string; exact?: string; partial: boolean; allHistory: boolean }) {
  return <article className="stats-kpi"><div className="stats-kpi-top"><span>{label}</span><Icon size={16} /></div><div className="stats-kpi-value" title={exact}>{value}</div><div className="stats-kpi-note">{note}{partial && <span className="stats-partial" title="Available data only; usage or observation history may be incomplete">partial</span>}</div>{!allHistory && <div className="stats-kpi-compare">{previous}</div>}</article>;
}
function Summary({ current, previous, allHistory }: { current: UsageMetrics; previous: UsageMetrics; allHistory: boolean }) {
  const cards = [
    { label: "Total tokens", value: tokens(current.tokens.total), previous: compare(current.tokens.total, previous.tokens.total), icon: Cpu, note: "Selected period", exact: `${count(current.tokens.total)} tokens` },
    { label: "Agent time", value: duration(current.running_ms), previous: compare(current.running_ms, previous.running_ms), icon: Timer, note: "Sum of observed Running intervals" },
    { label: "Active time", value: duration(current.active_ms), previous: compare(current.active_ms, previous.active_ms), icon: Activity, note: "At least one agent in Running" },
    { label: "Tasks", value: count(current.tasks), previous: compare(current.tasks, previous.tasks), icon: Layers3, note: "Main sessions and their subagents" },
    { label: "Model calls", value: count(current.calls), previous: compare(current.calls, previous.calls), icon: MessageSquare, note: `${count(current.turns)} user turns` },
    { label: "Active days", value: count(current.active_days), previous: compare(current.active_days, previous.active_days), icon: CalendarDays, note: "Usage or observed Running" },
  ];
  return <div className="stats-kpis">{cards.map((card) => <Metric key={card.label} {...card} partial={current.incomplete} allHistory={allHistory} />)}</div>;
}
function BreakdownTable({ rows, dimension, totalTokens, selected, onSelect }: { rows: StatsBreakdown[]; dimension: Dimension; totalTokens: number; selected: string[]; onSelect: (key: string) => void }) {
  const [sortBy, setSortBy] = useState<"tokens" | "running">("tokens");
  const sorted = useMemo(() => [...rows].sort((a, b) => sortBy === "tokens" ? b.tokens.total - a.tokens.total : (b.running_ms ?? -1) - (a.running_ms ?? -1)), [rows, sortBy]);
  const max = Math.max(...rows.map((row) => row.tokens.total), 1);
  if (!rows.length) return <div className="stats-table-empty">No data for this breakdown.</div>;
  const label = (row: StatsBreakdown) => dimension === "source" ? sourceName(row.key) : dimension === "project" ? projectName(row.label) : readable(row.label);
  return <div className="stats-table-scroll stats-breakdown-scroll"><table className="stats-table stats-breakdown-table"><thead><tr><th>{DIMENSIONS.find((d) => d.key === dimension)?.label}</th><th><button type="button" onClick={() => setSortBy("tokens")} className={sortBy === "tokens" ? "stats-sort-active" : ""}>Tokens ↓</button></th><th>Share</th><th><button type="button" onClick={() => setSortBy("running")} className={sortBy === "running" ? "stats-sort-active" : ""}>Running ↓</button></th><th>Tasks</th><th>Calls</th><th>Input cache</th></tr></thead><tbody>{sorted.map((row) => <tr key={row.key} className={selected.includes(row.key) ? "stats-selected-row" : ""}><td><button type="button" className="stats-dimension-button" title={`Filter: ${row.label}`} onClick={() => onSelect(row.key)}><span className="stats-dimension-bar" style={{ width: `${Math.max(0, row.tokens.total / max * 100)}%` }} /><span className="stats-dimension-label">{dimension === "source" && <i className="stats-source-dot" data-source={row.key} />}{label(row)}{selected.includes(row.key) && <span className="stats-filter-tick">✓</span>}</span></button></td><td title={count(row.tokens.total)}>{tokens(row.tokens.total)}{row.incomplete && <span className="stats-partial-dot" title="Partial data">*</span>}</td><td>{percent(row.tokens.total, totalTokens)}</td><td>{duration(row.running_ms)}</td><td>{count(row.tasks)}</td><td>{count(row.calls)}</td><td>{cacheShare(row.tokens)}</td></tr>)}</tbody></table></div>;
}
function SourceStatus({ data }: { data: StatsDashboardPayload }) {
  return <div className="stats-source-status">{data.sources.map((source) => <div key={source.source} className="stats-import-source"><span className="stats-source-dot" data-source={source.source} /><b>{sourceName(source.source)}</b>{source.state === "loading" ? <><Loader2 size={12} className="animate-spin" /><span>Indexing {count(source.indexed)} / {count(source.total)}</span><span className="stats-import-meter"><i style={{ width: `${Math.min(100, source.total ? source.indexed / source.total * 100 : 0)}%` }} /></span></> : source.state === "unavailable" ? <span className="stats-warning" title={source.message ?? undefined}>Unavailable{source.message ? ` · ${source.message}` : ""}</span> : <span className="stats-muted">{count(source.indexed)} sessions</span>}{source.skipped > 0 && <span className="stats-warning" title="Unsupported records skipped">Skipped {count(source.skipped)}</span>}</div>)}</div>;
}
export default function Statistics({ activeSessionIds, onBack, onBoard, onQueryChange }: { activeSessionIds: Set<string>; onBack: () => void; onBoard: (id: string) => void; onQueryChange: (search: string) => void }) {
  const [filters, setFilters] = useState<StatsFilters>(() => parseFilters(window.location.search));
  const [preset, setPreset] = useState<Preset>(initialPreset);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [page, setPage] = useState(initialPage);
  const [dimension, setDimension] = useState<Dimension>("model");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const query = useMemo(() => { const params = serializeFilters(filters); params.set("period", preset); return params.toString(); }, [filters, preset]);
  const dashboard = useStatsRequest<StatsDashboardPayload>(`/api/stats?${query}`, refresh);
  const ranking = useStatsRequest<StatsSessionsPayload>(`/api/stats/sessions?${query}&sort=${sort}&page=${page}&limit=50`, refresh);
  const data = dashboard.data;
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const updateFilters = useCallback((next: StatsFilters) => { setFilters(next); setPage(1); }, []);
  useEffect(() => {
    const params = serializeFilters(filters); params.set("period", preset); params.set("sort", sort); if (page > 1) params.set("page", String(page));
    window.history.replaceState(window.history.state, "", `/stats?${params}`);
    onQueryChange(`?${params}`);
  }, [filters, preset, sort, page, onQueryChange]);
  useEffect(() => {
    const handle = () => { setFilters(parseFilters(window.location.search)); setPreset(initialPreset()); setSort(initialSort()); setPage(initialPage()); setSelectedId(null); };
    window.addEventListener("popstate", handle);
    return () => window.removeEventListener("popstate", handle);
  }, []);
  useEffect(() => {
    const updatePeriod = () => {
      const next = refreshRelativeFilters(filters, preset);
      if (next !== filters) updateFilters(next);
    };
    const timer = window.setInterval(updatePeriod, 30_000);
    return () => window.clearInterval(timer);
  }, [filters, preset, updateFilters]);
  function selectRange(from: number, to: number) { setPreset("custom"); updateFilters({ ...filters, from, to }); }
  function reset() { setPreset("7"); updateFilters({ ...parseFilters(""), ...calendarPeriod("7") }); }
  const currentDimension = DIMENSIONS.find((d) => d.key === dimension)!;
  const totalPages = ranking.data ? Math.max(1, Math.ceil(ranking.data.total / ranking.data.limit)) : 1;
  useEffect(() => {
    if (ranking.data && page > totalPages) setPage(totalPages);
  }, [ranking.data, page, totalPages]);
  return <div className="stats-screen" data-testid="statistics-screen">
    <div className="stats-container">
      <div className="stats-navigation"><button type="button" className="stats-back" onClick={onBack}><ArrowLeft size={16} />Back to board</button><div className="stats-refresh-status">{data && <span>Updated {new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: filters.timezone }).format(data.generated_at)}</span>}<button type="button" className="stats-button" onClick={() => setRefresh((r) => r + 1)} disabled={dashboard.pending}><RefreshCw size={14} className={dashboard.pending ? "animate-spin" : ""} />Refresh</button></div></div>
      <div className="stats-heading"><div><span className="stats-eyebrow">OpenCode and Codex CLI history</span><h1>Agent usage</h1><p>Token consumption, working time, and the tasks that used the most resources.</p></div><button type="button" className="stats-help-button" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}><CircleHelp size={17} />How it works</button></div>
      {showHelp && <div className="stats-help"><p><b>Tokens</b> represent request usage, not context size. Input, cache, output, and reasoning are counted without overlap.</p><p><b>Agent time</b> sums observed Running intervals. Two parallel agents working for one hour produce two agent-hours and one active hour.</p><p><b>Task</b> includes a main session and its OpenCode subagents. Rankings include only contributions that match the selected filters.</p><p>Monitor downtime, Attention, and IDLE are excluded. Older sessions may have no observed time and display “No data”. Rankings show measured resource usage.</p></div>}
      <FilterBar filters={filters} preset={preset} facets={data?.facets} onChange={updateFilters} onPreset={setPreset} onReset={reset} />
      {dashboard.error && <div className="stats-error-banner" role="alert">{dashboard.error}<button type="button" onClick={() => setRefresh((r) => r + 1)}>Retry</button></div>}
      {dashboard.pending && !data && <div className="stats-loading stats-initial-loading"><Loader2 size={25} className="animate-spin" /><span>Loading usage statistics…</span></div>}
      {data && <>
        <SourceStatus data={data} />
        <div className="stats-coverage-note"><Activity size={14} /><span>Time includes only observed Running intervals{data.observation_since !== null ? ` · observed since ${dateLabel(data.observation_since, filters.timezone, true)}` : " · no observations yet"}. {data.summary.incomplete && "Partial data."}</span></div>
        {data.undated_calls > 0 && <p className="stats-warning-banner">{count(data.undated_calls)} calls have no confirmed date. Their usage appears only in all-time totals, not in daily charts.</p>}
        <Summary current={data.summary} previous={data.previous} allHistory={filters.from === 0} />
        <section className="stats-section"><div className="stats-section-title"><div><h2><BarChart3 size={18} />Usage over time</h2><p>Token usage and Running time. Click a bar to explore a day.</p></div><select className="stats-select" aria-label="Chart granularity" value={filters.granularity} onChange={(event) => updateFilters({ ...filters, granularity: event.target.value as StatsFilters["granularity"] })}><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select></div><div className="stats-two-columns"><article className="stats-panel"><div className="stats-panel-title"><h3>Token consumption</h3><span>{tokens(data.summary.tokens.total)} total</span></div><SeriesChart series={data.series} filters={filters} mode="tokens" onRange={selectRange} /></article><article className="stats-panel"><div className="stats-panel-title"><h3>Running time</h3><span>{duration(data.summary.running_ms)}</span></div><SeriesChart series={data.series} filters={filters} mode="running" onRange={selectRange} /></article></div></section>
        <section className="stats-section stats-panel"><div className="stats-section-title"><div><h2>Where resources go</h2><p>Click a name to filter the dashboard.</p></div><div className="stats-tablist" role="tablist" aria-label="Usage breakdowns">{DIMENSIONS.map((d) => <button type="button" role="tab" aria-selected={dimension === d.key} key={d.key} className={dimension === d.key ? "stats-tab-active" : ""} onClick={() => setDimension(d.key)}>{d.label}</button>)}</div></div><BreakdownTable key={dimension} rows={data.breakdowns[dimension]} dimension={dimension} totalTokens={data.summary.tokens.total} selected={filters[currentDimension.field]} onSelect={(key) => updateFilters({ ...filters, [currentDimension.field]: toggleValue(filters[currentDimension.field], key) })} /></section>
        <section className="stats-section"><div className="stats-two-columns"><article className="stats-panel"><div className="stats-panel-title"><h3>Work patterns</h3><span>{filters.timezone}</span></div><Heatmap cells={data.heatmap} /></article><article className="stats-panel"><div className="stats-panel-title"><h3>Tokens × Running time</h3><span>Up to 200 tasks</span></div><Scatter rows={data.scatter} onSelect={setSelectedId} /></article></div></section>
        <section className="stats-section stats-panel stats-ranking"><div className="stats-section-title"><div><h2>Most resource-intensive tasks</h2><p>Main sessions include their subagents. Open a task to inspect its contributions.</p></div><div className="stats-sort-control"><span>Rank by</span><select className="stats-select" aria-label="Task ranking" value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1); }}><option value="running">Running time</option><option value="tokens">Tokens</option><option value="turns">Turns</option></select></div></div>
          {ranking.error && <p className="stats-error" role="alert">{ranking.error}</p>}
          {ranking.pending && !ranking.data && <div className="stats-loading"><Loader2 size={18} className="animate-spin" />Loading rankings…</div>}
          {ranking.data && (ranking.data.rows.length ? <div className="stats-table-scroll"><table className="stats-table stats-tasks-table"><thead><tr><th>#</th><th>Task / project</th><th>Agents / models</th><th>Tokens</th><th title="Sum of observed Running for all participants">Running</th><th title="At least one participant in Running">Active time</th><th>Turns</th><th>Subagents</th><th /></tr></thead><tbody>{ranking.data.rows.map((row, index) => <tr key={row.id}><td className="stats-rank-number">{(ranking.data!.page - 1) * ranking.data!.limit + index + 1}</td><td><button type="button" className="stats-task-name" onClick={() => setSelectedId(row.id)} title={row.title}><span className="stats-task-title">{row.title || "Untitled"}{row.incomplete && <span className="stats-partial-dot" title="Partial data">*</span>}</span><span className="stats-task-project"><i className="stats-source-dot" data-source={row.source} />{projectName(row.directory)}<span className="stats-task-source">{sourceName(row.source)}</span></span></button></td><td><div className="stats-task-agents" title={row.agents.join(", ")}>{row.agents.map(readable).join(", ") || "Unknown"}</div><div className="stats-task-models" title={row.models.join(", ")}>{row.models.map(readable).join(", ") || "Unknown"}</div></td><td title={count(row.tokens.total)}>{tokens(row.tokens.total)}</td><td>{duration(row.running_ms)}</td><td>{duration(row.active_ms)}</td><td>{count(row.turns)}</td><td>{row.subagents ? <span className="stats-small-tag">{row.subagents}</span> : "—"}</td><td><button type="button" className="stats-icon-button" onClick={() => setSelectedId(row.id)} aria-label={`Task statistics: ${row.title}`}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <div className="stats-table-empty">No tasks found. Try another period or reset the filters.</div>)}
          {ranking.data && <div className="stats-pagination"><span>{count(ranking.data.total)} tasks{ranking.pending && " · refreshing…"}</span><div><button type="button" className="stats-button" disabled={page <= 1 || ranking.pending} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button><span>Page {page} of {totalPages}</span><button type="button" className="stats-button" disabled={page >= totalPages || ranking.pending} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={14} /></button></div></div>}
        </section>
        {data.summary.cost !== null && <div className="stats-cost">Cost recorded by source: <b>{data.summary.cost.toLocaleString("en-US", { maximumFractionDigits: 4 })}</b><span>Recorded for {count(data.summary.cost_calls)} of {count(data.summary.calls)} calls ({percent(data.summary.cost_calls, data.summary.calls)}).</span></div>}
        <footer className="stats-footer">Local statistics · read-only source history · refreshes every 30 seconds</footer>
      </>}
    </div>
    {selectedId && <TaskDetail id={selectedId} filters={filters} refresh={refresh} activeSessionIds={activeSessionIds} onClose={closeDetail} onBoard={onBoard} />}
  </div>;
}
