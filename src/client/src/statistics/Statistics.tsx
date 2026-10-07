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
  { key: "source", label: "Источники", field: "sources" }, { key: "agent", label: "Агенты", field: "agents" }, { key: "model", label: "Модели", field: "models" }, { key: "project", label: "Проекты", field: "projects" },
];
function initialPreset(): Preset {
  const search = new URLSearchParams(window.location.search), preset = search.get("period");
  return PRESETS.some((p) => p.key === preset) ? preset as Preset : search.get("from") === "0" ? "all" : search.has("from") ? "custom" : "7";
}
function initialSort(): Sort { const sort = new URLSearchParams(window.location.search).get("sort"); return sort === "tokens" || sort === "turns" ? sort : "running"; }
function initialPage(): number { const value = Number(new URLSearchParams(window.location.search).get("page")); return Number.isInteger(value) && value > 0 ? value : 1; }
function Metric({ label, value, previous, icon: Icon, note, exact, partial, allHistory }: { label: string; value: string; previous: string; icon: typeof Cpu; note: string; exact?: string; partial: boolean; allHistory: boolean }) {
  return <article className="stats-kpi"><div className="stats-kpi-top"><span>{label}</span><Icon size={16} /></div><div className="stats-kpi-value" title={exact}>{value}</div><div className="stats-kpi-note">{note}{partial && <span className="stats-partial" title="Показаны доступные данные; история расхода или наблюдений может быть неполной">частично</span>}</div>{!allHistory && <div className="stats-kpi-compare">{previous}</div>}</article>;
}
function Summary({ current, previous, allHistory }: { current: UsageMetrics; previous: UsageMetrics; allHistory: boolean }) {
  const cards = [
    { label: "Всего токенов", value: tokens(current.tokens.total), previous: compare(current.tokens.total, previous.tokens.total), icon: Cpu, note: "За выбранный период", exact: `${count(current.tokens.total)} токенов` },
    { label: "Время агентов", value: duration(current.running_ms), previous: compare(current.running_ms, previous.running_ms), icon: Timer, note: "Сумма интервалов Running" },
    { label: "Время активности", value: duration(current.active_ms), previous: compare(current.active_ms, previous.active_ms), icon: Activity, note: "Хотя бы один агент в Running" },
    { label: "Задачи", value: count(current.tasks), previous: compare(current.tasks, previous.tasks), icon: Layers3, note: "Основные сессии и их деревья" },
    { label: "Вызовы моделей", value: count(current.calls), previous: compare(current.calls, previous.calls), icon: MessageSquare, note: `${count(current.turns)} пользовательских ходов` },
    { label: "Активные дни", value: count(current.active_days), previous: compare(current.active_days, previous.active_days), icon: CalendarDays, note: "Расход или наблюдавшийся Running" },
  ];
  return <div className="stats-kpis">{cards.map((card) => <Metric key={card.label} {...card} partial={current.incomplete} allHistory={allHistory} />)}</div>;
}
function BreakdownTable({ rows, dimension, totalTokens, selected, onSelect }: { rows: StatsBreakdown[]; dimension: Dimension; totalTokens: number; selected: string[]; onSelect: (key: string) => void }) {
  const [sortBy, setSortBy] = useState<"tokens" | "running">("tokens");
  const sorted = useMemo(() => [...rows].sort((a, b) => sortBy === "tokens" ? b.tokens.total - a.tokens.total : (b.running_ms ?? -1) - (a.running_ms ?? -1)), [rows, sortBy]);
  const max = Math.max(...rows.map((row) => row.tokens.total), 1);
  if (!rows.length) return <div className="stats-table-empty">В выбранном разрезе нет данных.</div>;
  const label = (row: StatsBreakdown) => dimension === "source" ? sourceName(row.key) : dimension === "project" ? projectName(row.label) : readable(row.label);
  return <div className="stats-table-scroll stats-breakdown-scroll"><table className="stats-table stats-breakdown-table"><thead><tr><th>{DIMENSIONS.find((d) => d.key === dimension)?.label}</th><th><button type="button" onClick={() => setSortBy("tokens")} className={sortBy === "tokens" ? "stats-sort-active" : ""}>Токены ↓</button></th><th>Доля</th><th><button type="button" onClick={() => setSortBy("running")} className={sortBy === "running" ? "stats-sort-active" : ""}>Running ↓</button></th><th>Задачи</th><th>Вызовы</th><th>Кэш входа</th></tr></thead><tbody>{sorted.map((row) => <tr key={row.key} className={selected.includes(row.key) ? "stats-selected-row" : ""}><td><button type="button" className="stats-dimension-button" title={`Фильтр: ${row.label}`} onClick={() => onSelect(row.key)}><span className="stats-dimension-bar" style={{ width: `${Math.max(0, row.tokens.total / max * 100)}%` }} /><span className="stats-dimension-label">{dimension === "source" && <i className="stats-source-dot" data-source={row.key} />}{label(row)}{selected.includes(row.key) && <span className="stats-filter-tick">✓</span>}</span></button></td><td title={count(row.tokens.total)}>{tokens(row.tokens.total)}{row.incomplete && <span className="stats-partial-dot" title="Частичные данные">*</span>}</td><td>{percent(row.tokens.total, totalTokens)}</td><td>{duration(row.running_ms)}</td><td>{count(row.tasks)}</td><td>{count(row.calls)}</td><td>{cacheShare(row.tokens)}</td></tr>)}</tbody></table></div>;
}
function SourceStatus({ data }: { data: StatsDashboardPayload }) {
  return <div className="stats-source-status">{data.sources.map((source) => <div key={source.source} className="stats-import-source"><span className="stats-source-dot" data-source={source.source} /><b>{sourceName(source.source)}</b>{source.state === "loading" ? <><Loader2 size={12} className="animate-spin" /><span>Индексируется {count(source.indexed)} / {count(source.total)}</span><span className="stats-import-meter"><i style={{ width: `${Math.min(100, source.total ? source.indexed / source.total * 100 : 0)}%` }} /></span></> : source.state === "unavailable" ? <span className="stats-warning" title={source.message ?? undefined}>Недоступен{source.message ? ` · ${source.message}` : ""}</span> : <span className="stats-muted">{count(source.indexed)} сессий</span>}{source.skipped > 0 && <span className="stats-warning" title="Повреждённые или неподдерживаемые записи пропущены">Пропущено {count(source.skipped)}</span>}</div>)}</div>;
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
      <div className="stats-navigation"><button type="button" className="stats-back" onClick={onBack}><ArrowLeft size={16} />К доске</button><div className="stats-refresh-status">{data && <span>Обновлено {new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: filters.timezone }).format(data.generated_at)}</span>}<button type="button" className="stats-button" onClick={() => setRefresh((r) => r + 1)} disabled={dashboard.pending}><RefreshCw size={14} className={dashboard.pending ? "animate-spin" : ""} />Обновить</button></div></div>
      <div className="stats-heading"><div><span className="stats-eyebrow">История OpenCode и Codex CLI</span><h1>Использование агентов</h1><p>Расход токенов, время работы и задачи, потребовавшие больше всего ресурсов.</p></div><button type="button" className="stats-help-button" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}><CircleHelp size={17} />Как считаем</button></div>
      {showHelp && <div className="stats-help"><p><b>Токены</b> — расход запросов, а не размер контекста. Вход, кэш, ответ и reasoning приведены к категориям без повторного счёта.</p><p><b>Время агентов</b> — сумма наблюдавшихся интервалов Running. Два параллельных агента за час дают 2 агент-часа и 1 час активности.</p><p><b>Задача</b> — основная сессия со своим деревом субагентов OpenCode. Рейтинг суммирует только вклад участников, соответствующих фильтрам.</p><p>Время при выключенном KlipRun, Attention и IDLE не прибавляется. У старых сессий время может отсутствовать; это отображается как «Нет данных». Топ показывает измеряемую ресурсоёмкость.</p></div>}
      <FilterBar filters={filters} preset={preset} facets={data?.facets} onChange={updateFilters} onPreset={setPreset} onReset={reset} />
      {dashboard.error && <div className="stats-error-banner" role="alert">{dashboard.error}<button type="button" onClick={() => setRefresh((r) => r + 1)}>Повторить</button></div>}
      {dashboard.pending && !data && <div className="stats-loading stats-initial-loading"><Loader2 size={25} className="animate-spin" /><span>Собираем статистику использования…</span></div>}
      {data && <>
        <SourceStatus data={data} />
        <div className="stats-coverage-note"><Activity size={14} /><span>Время — только наблюдавшийся Running{data.observation_since !== null ? ` · история наблюдений с ${dateLabel(data.observation_since, filters.timezone, true)}` : " · история наблюдений пока отсутствует"}. {data.summary.incomplete && "Данные частичные."}</span></div>
        {data.undated_calls > 0 && <p className="stats-warning-banner">{count(data.undated_calls)} вызовов без подтверждённой даты: их расход доступен в итогах за всю историю и не распределяется по дням.</p>}
        <Summary current={data.summary} previous={data.previous} allHistory={filters.from === 0} />
        <section className="stats-section"><div className="stats-section-title"><div><h2><BarChart3 size={18} />Динамика использования</h2><p>Токены и время показаны отдельно; столбец открывает свой период.</p></div><select className="stats-select" aria-label="Гранулярность графиков" value={filters.granularity} onChange={(event) => updateFilters({ ...filters, granularity: event.target.value as StatsFilters["granularity"] })}><option value="day">По дням</option><option value="week">По неделям</option><option value="month">По месяцам</option></select></div><div className="stats-two-columns"><article className="stats-panel"><div className="stats-panel-title"><h3>Расход токенов</h3><span>{tokens(data.summary.tokens.total)} всего</span></div><SeriesChart series={data.series} filters={filters} mode="tokens" onRange={selectRange} /></article><article className="stats-panel"><div className="stats-panel-title"><h3>Время в Running</h3><span>{duration(data.summary.running_ms)}</span></div><SeriesChart series={data.series} filters={filters} mode="running" onRange={selectRange} /></article></div></section>
        <section className="stats-section stats-panel"><div className="stats-section-title"><div><h2>Куда уходят ресурсы</h2><p>Нажмите на название, чтобы добавить его в фильтр.</p></div><div className="stats-tablist" role="tablist" aria-label="Разрезы статистики">{DIMENSIONS.map((d) => <button type="button" role="tab" aria-selected={dimension === d.key} key={d.key} className={dimension === d.key ? "stats-tab-active" : ""} onClick={() => setDimension(d.key)}>{d.label}</button>)}</div></div><BreakdownTable key={dimension} rows={data.breakdowns[dimension]} dimension={dimension} totalTokens={data.summary.tokens.total} selected={filters[currentDimension.field]} onSelect={(key) => updateFilters({ ...filters, [currentDimension.field]: toggleValue(filters[currentDimension.field], key) })} /></section>
        <section className="stats-section"><div className="stats-two-columns"><article className="stats-panel"><div className="stats-panel-title"><h3>Ритм работы</h3><span>{filters.timezone}</span></div><Heatmap cells={data.heatmap} /></article><article className="stats-panel"><div className="stats-panel-title"><h3>Токены × время Running</h3><span>До 200 задач</span></div><Scatter rows={data.scatter} onSelect={setSelectedId} /></article></div></section>
        <section className="stats-section stats-panel stats-ranking"><div className="stats-section-title"><div><h2>Самые ресурсоёмкие задачи</h2><p>Основная сессия и вклад её субагентов. Откройте строку для подробностей.</p></div><div className="stats-sort-control"><span>Топ по</span><select className="stats-select" aria-label="Критерий рейтинга задач" value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1); }}><option value="running">Времени Running</option><option value="tokens">Токенам</option><option value="turns">Числу ходов</option></select></div></div>
          {ranking.error && <p className="stats-error" role="alert">{ranking.error}</p>}
          {ranking.pending && !ranking.data && <div className="stats-loading"><Loader2 size={18} className="animate-spin" />Загрузка рейтинга…</div>}
          {ranking.data && (ranking.data.rows.length ? <div className="stats-table-scroll"><table className="stats-table stats-tasks-table"><thead><tr><th>#</th><th>Задача / проект</th><th>Агенты / модели</th><th>Токены</th><th title="Сумма наблюдавшегося Running всех участников">Running</th><th title="Хотя бы один участник задачи в Running">Активность</th><th>Ходы</th><th>Субагенты</th><th /></tr></thead><tbody>{ranking.data.rows.map((row, index) => <tr key={row.id}><td className="stats-rank-number">{(ranking.data!.page - 1) * ranking.data!.limit + index + 1}</td><td><button type="button" className="stats-task-name" onClick={() => setSelectedId(row.id)} title={row.title}><span className="stats-task-title">{row.title || "Без названия"}{row.incomplete && <span className="stats-partial-dot" title="Данные частичные">*</span>}</span><span className="stats-task-project"><i className="stats-source-dot" data-source={row.source} />{projectName(row.directory)}<span className="stats-task-source">{sourceName(row.source)}</span></span></button></td><td><div className="stats-task-agents" title={row.agents.join(", ")}>{row.agents.map(readable).join(", ") || "Неизвестно"}</div><div className="stats-task-models" title={row.models.join(", ")}>{row.models.map(readable).join(", ") || "Неизвестно"}</div></td><td title={count(row.tokens.total)}>{tokens(row.tokens.total)}</td><td>{duration(row.running_ms)}</td><td>{duration(row.active_ms)}</td><td>{count(row.turns)}</td><td>{row.subagents ? <span className="stats-small-tag">{row.subagents}</span> : "—"}</td><td><button type="button" className="stats-icon-button" onClick={() => setSelectedId(row.id)} aria-label={`Статистика задачи ${row.title}`}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <div className="stats-table-empty">Задачи не найдены. Попробуйте другой период или сбросьте фильтры.</div>)}
          {ranking.data && <div className="stats-pagination"><span>{count(ranking.data.total)} задач{ranking.pending && " · обновление…"}</span><div><button type="button" className="stats-button" disabled={page <= 1 || ranking.pending} onClick={() => setPage((p) => p - 1)} aria-label="Предыдущая страница"><ChevronLeft size={14} /></button><span>Страница {page} из {totalPages}</span><button type="button" className="stats-button" disabled={page >= totalPages || ranking.pending} onClick={() => setPage((p) => p + 1)} aria-label="Следующая страница"><ChevronRight size={14} /></button></div></div>}
        </section>
        {data.summary.cost !== null && <div className="stats-cost">Стоимость по данным источника: <b>{data.summary.cost.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}</b><span>Указана для {count(data.summary.cost_calls)} из {count(data.summary.calls)} вызовов ({percent(data.summary.cost_calls, data.summary.calls)}).</span></div>}
        <footer className="stats-footer">Локальная статистика · история источников только для чтения · обновление каждые 30 секунд</footer>
      </>}
    </div>
    {selectedId && <TaskDetail id={selectedId} filters={filters} refresh={refresh} activeSessionIds={activeSessionIds} onClose={closeDetail} onBoard={onBoard} />}
  </div>;
}
