import { useEffect, useState } from "react";
import { CalendarDays, Check, ChevronDown, RotateCcw, Search } from "lucide-react";
import type { StatsDashboardPayload, StatsFilters } from "@shared/usage";
import { calendarPeriod, dateRange, dateText, toggleValue, type Preset } from "./filters";
import { projectName, readable, sourceName } from "./format";

export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "today", label: "Сегодня" }, { key: "yesterday", label: "Вчера" }, { key: "7", label: "7 дней" }, { key: "30", label: "30 дней" }, { key: "month", label: "Этот месяц" }, { key: "all", label: "Вся история" }, { key: "custom", label: "Свои даты" },
];
function FacetPicker({ label, options, selected, onChange, display = readable }: { label: string; options: string[]; selected: string[]; onChange: (values: string[]) => void; display?: (value: string) => string }) {
  const [search, setSearch] = useState("");
  const values = [...new Set([...selected, ...options])].filter((value) => `${display(value)} ${value}`.toLowerCase().includes(search.toLowerCase()));
  return <details className="stats-facet">
    <summary className={selected.length ? "stats-facet-selected" : ""}>{label}{selected.length > 0 && <span className="stats-count-badge">{selected.length}</span>}<ChevronDown size={13} /></summary>
    <div className="stats-facet-popover">
      <label className="stats-search"><Search size={14} /><input aria-label={`Поиск: ${label}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти…" /></label>
      <div className="stats-facet-options">
        {values.length ? values.map((value) => <label key={value} title={value} className="stats-facet-option"><input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(toggleValue(selected, value))} /><span>{display(value)}</span>{selected.includes(value) && <Check size={13} />}</label>) : <span className="stats-muted stats-facet-empty">Совпадений нет</span>}
      </div>
      {selected.length > 0 && <button type="button" className="stats-facet-clear" onClick={() => onChange([])}>Очистить выбор</button>}
    </div>
  </details>;
}
export function FilterBar({ filters, preset, facets, onChange, onPreset, onReset }: { filters: StatsFilters; preset: Preset; facets: StatsDashboardPayload["facets"] | undefined; onChange: (filters: StatsFilters) => void; onPreset: (preset: Preset) => void; onReset: () => void }) {
  const [fromDate, setFromDate] = useState(dateText(filters.from, filters.timezone));
  const [toDate, setToDate] = useState(dateText(filters.to - 1, filters.timezone));
  useEffect(() => { setFromDate(dateText(filters.from, filters.timezone)); setToDate(dateText(filters.to - 1, filters.timezone)); }, [filters.from, filters.to, filters.timezone]);
  const customRange = dateRange(fromDate, toDate, filters.timezone);
  const hasSelections = filters.sources.length + filters.agents.length + filters.models.length + filters.projects.length > 0 || filters.role !== "all";
  function choose(next: Preset) {
    onPreset(next);
    if (next !== "custom") onChange({ ...filters, ...calendarPeriod(next, Date.now(), filters.timezone), ...(next === "all" ? { granularity: "month" } : {}) });
  }
  return <section className="stats-filterbar" aria-label="Фильтры статистики">
    <div className="stats-period-row"><CalendarDays size={17} className="stats-muted" /><div className="stats-presets">{PRESETS.map(({ key, label }) => <button type="button" key={key} onClick={() => choose(key)} className={preset === key ? "stats-preset stats-preset-active" : "stats-preset"} aria-pressed={preset === key}>{label}</button>)}</div><span className="stats-timezone">{filters.timezone}</span></div>
    {preset === "custom" && <div className="stats-custom-period"><label>С <input type="date" aria-label="Начало периода" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label>По <input type="date" aria-label="Конец периода включительно" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label><button type="button" className="stats-button stats-button-primary" disabled={!customRange} onClick={() => customRange && onChange({ ...filters, ...customRange })}>Применить</button>{!customRange && <span className="stats-warning">Проверьте порядок дат</span>}</div>}
    <div className="stats-filters-row">
      <FacetPicker label="Источник" options={facets?.sources ?? ["opencode", "codex"]} selected={filters.sources} onChange={(sources) => onChange({ ...filters, sources })} display={sourceName} />
      <FacetPicker label="Агент" options={facets?.agents ?? []} selected={filters.agents} onChange={(agents) => onChange({ ...filters, agents })} />
      <FacetPicker label="Модель" options={facets?.models ?? []} selected={filters.models} onChange={(models) => onChange({ ...filters, models })} />
      <FacetPicker label="Проект" options={facets?.projects ?? []} selected={filters.projects} onChange={(projects) => onChange({ ...filters, projects })} display={(value) => value === "unknown" ? "Неизвестно" : projectName(value)} />
      <select className="stats-select" aria-label="Основные сессии и субагенты" value={filters.role} onChange={(event) => onChange({ ...filters, role: event.target.value as StatsFilters["role"] })}><option value="all">Все участники</option><option value="roots">Основные сессии</option><option value="children">Только субагенты</option></select>
      <div className="stats-filter-spacer" />
      {hasSelections && <span className="stats-filter-count">Выбор применён</span>}
      <button type="button" className="stats-button stats-reset" onClick={onReset}><RotateCcw size={13} />Сбросить</button>
    </div>
    {hasSelections && <div className="stats-selected-filters">{([["sources", sourceName], ["agents", readable], ["models", readable], ["projects", projectName]] as const).flatMap(([key, display]) => filters[key].map((value) => <button key={`${key}:${value}`} type="button" title={`Убрать фильтр ${value}`} onClick={() => onChange({ ...filters, [key]: filters[key].filter((v) => v !== value) })}>{display(value)} <span aria-hidden="true">×</span></button>))}</div>}
  </section>;
}
