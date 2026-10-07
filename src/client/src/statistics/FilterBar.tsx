import { useEffect, useState } from "react";
import { CalendarDays, Check, ChevronDown, RotateCcw, Search } from "lucide-react";
import type { StatsDashboardPayload, StatsFilters } from "@shared/usage";
import { calendarPeriod, dateRange, dateText, toggleValue, type Preset } from "./filters";
import { projectName, readable, sourceName } from "./format";

export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "7", label: "Last 7 days" }, { key: "30", label: "Last 30 days" }, { key: "month", label: "This month" }, { key: "all", label: "All time" }, { key: "custom", label: "Custom range" },
];
function FacetPicker({ label, options, selected, onChange, display = readable }: { label: string; options: string[]; selected: string[]; onChange: (values: string[]) => void; display?: (value: string) => string }) {
  const [search, setSearch] = useState("");
  const values = [...new Set([...selected, ...options])].filter((value) => `${display(value)} ${value}`.toLowerCase().includes(search.toLowerCase()));
  return <details className="stats-facet">
    <summary className={selected.length ? "stats-facet-selected" : ""}>{label}{selected.length > 0 && <span className="stats-count-badge">{selected.length}</span>}<ChevronDown size={13} /></summary>
    <div className="stats-facet-popover">
      <label className="stats-search"><Search size={14} /><input aria-label={`Search: ${label}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search…" /></label>
      <div className="stats-facet-options">
        {values.length ? values.map((value) => <label key={value} title={value} className="stats-facet-option"><input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(toggleValue(selected, value))} /><span>{display(value)}</span>{selected.includes(value) && <Check size={13} />}</label>) : <span className="stats-muted stats-facet-empty">No matches</span>}
      </div>
      {selected.length > 0 && <button type="button" className="stats-facet-clear" onClick={() => onChange([])}>Clear selection</button>}
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
  return <section className="stats-filterbar" aria-label="Statistics filters">
    <div className="stats-period-row"><CalendarDays size={17} className="stats-muted" /><div className="stats-presets">{PRESETS.map(({ key, label }) => <button type="button" key={key} onClick={() => choose(key)} className={preset === key ? "stats-preset stats-preset-active" : "stats-preset"} aria-pressed={preset === key}>{label}</button>)}</div><span className="stats-timezone">{filters.timezone}</span></div>
    {preset === "custom" && <div className="stats-custom-period"><label>From <input type="date" aria-label="Period start" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label>To <input type="date" aria-label="Period end, inclusive" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label><button type="button" className="stats-button stats-button-primary" disabled={!customRange} onClick={() => customRange && onChange({ ...filters, ...customRange })}>Apply</button>{!customRange && <span className="stats-warning">Check the date range</span>}</div>}
    <div className="stats-filters-row">
      <FacetPicker label="Source" options={facets?.sources ?? ["opencode", "codex"]} selected={filters.sources} onChange={(sources) => onChange({ ...filters, sources })} display={sourceName} />
      <FacetPicker label="Agent" options={facets?.agents ?? []} selected={filters.agents} onChange={(agents) => onChange({ ...filters, agents })} />
      <FacetPicker label="Model" options={facets?.models ?? []} selected={filters.models} onChange={(models) => onChange({ ...filters, models })} />
      <FacetPicker label="Project" options={facets?.projects ?? []} selected={filters.projects} onChange={(projects) => onChange({ ...filters, projects })} display={(value) => value === "unknown" ? "Unknown" : projectName(value)} />
      <select className="stats-select" aria-label="Main sessions and subagents" value={filters.role} onChange={(event) => onChange({ ...filters, role: event.target.value as StatsFilters["role"] })}><option value="all">All participants</option><option value="roots">Main sessions</option><option value="children">Subagents only</option></select>
      <div className="stats-filter-spacer" />
      {hasSelections && <span className="stats-filter-count">Filters applied</span>}
      <button type="button" className="stats-button stats-reset" onClick={onReset}><RotateCcw size={13} />Reset</button>
    </div>
    {hasSelections && <div className="stats-selected-filters">{([["sources", sourceName], ["agents", readable], ["models", readable], ["projects", projectName]] as const).flatMap(([key, display]) => filters[key].map((value) => <button key={`${key}:${value}`} type="button" title={`Remove filter: ${value}`} onClick={() => onChange({ ...filters, [key]: filters[key].filter((v) => v !== value) })}>{display(value)} <span aria-hidden="true">×</span></button>))}</div>}
  </section>;
}
