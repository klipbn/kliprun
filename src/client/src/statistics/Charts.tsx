import { useState } from "react";
import type { StatsBucket, StatsFilters, StatsHeatCell, StatsSessionRow } from "@shared/usage";
import { count, dateLabel, duration, tokens, TOKEN_PARTS } from "./format";

export function EmptyChart({ text = "За этот период данных нет" }: { text?: string }) {
  return <div className="stats-empty"><span className="stats-empty-line" /><p>{text}</p></div>;
}
export function SeriesChart({ series, filters, mode, onRange }: { series: StatsBucket[]; filters: StatsFilters; mode: "tokens" | "running"; onRange: (from: number, to: number) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (!series.length || !series.some((s) => mode === "tokens" ? s.tokens.total > 0 : (s.running_ms ?? 0) > 0)) return <EmptyChart text={mode === "running" ? "В этом периоде нет наблюдавшихся интервалов Running" : "В этом периоде нет расхода токенов"} />;
  const width = 680, height = 220, left = 57, bottom = 27, top = 12, innerWidth = width - left - 12, innerHeight = height - top - bottom;
  const max = Math.max(...series.map((s) => mode === "tokens" ? s.tokens.total : (s.running_ms ?? 0)), 1) * 1.1;
  const step = innerWidth / series.length, barWidth = Math.max(1, step * 0.7), y = (value: number) => top + innerHeight * (1 - value / max);
  const active = hovered !== null ? series[hovered] : null;
  const focusText = active ? `${dateLabel(active.from, filters.timezone)} · ${mode === "tokens" ? `${count(active.tokens.total)} токенов` : `${duration(active.running_ms)} агентов · ${duration(active.active_ms)} активности`}` : "Нажмите на столбец, чтобы выбрать период";
  return <div className="stats-chart-wrap">
    <div className="stats-chart-readout" aria-live="polite">{focusText}</div>
    <svg viewBox={`0 0 ${width} ${height}`} className="stats-chart" role="group" aria-label={mode === "tokens" ? "Расход токенов по времени" : "Наблюдавшееся время Running по времени"}>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}>
        <line x1={left} x2={width - 12} y1={y(max * fraction)} y2={y(max * fraction)} className="stats-grid-line" />
        <text x={left - 8} y={y(max * fraction) + 4} textAnchor="end" className="stats-axis-text">{mode === "tokens" ? tokens(max * fraction) : duration(max * fraction)}</text>
      </g>)}
      {series.map((bucket, index) => {
        const x = left + index * step + (step - barWidth) / 2;
        let base = 0;
        return <g key={bucket.key} role="button" tabIndex={0} aria-label={`${dateLabel(bucket.from, filters.timezone)}: ${mode === "tokens" ? `${count(bucket.tokens.total)} токенов` : `${duration(bucket.running_ms)} Running`}. Выбрать этот период.`} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(index)} onBlur={() => setHovered(null)} onClick={() => onRange(bucket.from, bucket.to)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRange(bucket.from, bucket.to); } }} className="stats-svg-button">
          <title>{`${dateLabel(bucket.from, filters.timezone)} · ${count(bucket.tokens.total)} токенов · Running ${duration(bucket.running_ms)}`}</title>
          <rect x={left + index * step} y={top} width={step} height={innerHeight} fill={hovered === index ? "#58a6ff0d" : "transparent"} />
          {mode === "tokens" ? TOKEN_PARTS.map((part) => { const amount = bucket.tokens[part.key], start = base; base += amount; return <rect key={part.key} x={x} y={y(base)} width={barWidth} height={Math.max(0, innerHeight * amount / max)} fill={part.color} opacity={hovered === index ? 1 : 0.85}><title>{part.label}: {count(base - start)}</title></rect>; }) : <>
            <rect x={x} y={y(bucket.running_ms ?? 0)} width={barWidth} height={innerHeight * (bucket.running_ms ?? 0) / max} fill="#58a6ff" opacity="0.8" rx="2" />
            <line x1={x} x2={x + barWidth} y1={y(bucket.active_ms ?? 0)} y2={y(bucket.active_ms ?? 0)} stroke="#3fb950" strokeWidth="3" />
          </>}
          {(series.length <= 10 || index % Math.ceil(series.length / 7) === 0 || index === series.length - 1) && <text x={x + barWidth / 2} y={height - 7} textAnchor="middle" className="stats-axis-text">{dateLabel(bucket.from, filters.timezone)}</text>}
        </g>;
      })}
    </svg>
    <div className="stats-legend">{mode === "tokens" ? TOKEN_PARTS.filter((p) => series.some((s) => s.tokens[p.key] > 0)).map((part) => <span key={part.key}><i style={{ background: part.color }} />{part.label}</span>) : <><span><i style={{ background: "#58a6ff" }} />Сумма времени агентов</span><span><i style={{ background: "#3fb950" }} />Хотя бы один агент</span></>}</div>
  </div>;
}
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export function Heatmap({ cells }: { cells: StatsHeatCell[] }) {
  const [selected, setSelected] = useState<StatsHeatCell | null>(null);
  const max = Math.max(...cells.map((c) => c.running_ms), 1);
  const lookup = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c]));
  if (!cells.some((c) => c.running_ms > 0)) return <EmptyChart text="Теплокарта появится после наблюдения Running" />;
  return <div>
    <div className="stats-chart-readout" aria-live="polite">{selected ? `${WEEKDAYS[selected.weekday]} ${String(selected.hour).padStart(2, "0")}:00 · ${duration(selected.running_ms)} агентов · ${duration(selected.active_ms)} активности · параллельность ${selected.active_ms ? (selected.running_ms / selected.active_ms).toFixed(1) : "0"}` : "Время Running по дням недели и часам"}</div>
    <div className="stats-heatmap-scroll"><div className="stats-heatmap">
      <span />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="stats-heat-hour">{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>)}
      {WEEKDAYS.map((label, weekday) => <div key={label} className="stats-heat-row"><span className="stats-heat-day">{label}</span>{Array.from({ length: 24 }, (_, hour) => {
        const cell = lookup.get(`${weekday}:${hour}`) ?? { weekday, hour, running_ms: 0, active_ms: 0 };
        const hint = `${label} ${hour}:00. ${duration(cell.running_ms)} агентов; ${duration(cell.active_ms)} активности`;
        return <button type="button" key={hour} className="stats-heat-cell" aria-label={hint} title={hint} onFocus={() => setSelected(cell)} onMouseEnter={() => setSelected(cell)} onClick={() => setSelected(cell)} style={{ background: cell.running_ms ? `rgba(88,166,255,${0.18 + 0.82 * Math.sqrt(cell.running_ms / max)})` : "#21262d" }} />;
      })}</div>)}
    </div></div>
    <div className="stats-heat-legend"><span>Меньше</span>{[0.08, 0.25, 0.5, 0.75, 1].map((opacity) => <i key={opacity} style={{ background: `rgba(88,166,255,${opacity})` }} />)}<span>Больше</span></div>
  </div>;
}
export function Scatter({ rows, onSelect }: { rows: StatsSessionRow[]; onSelect: (id: string) => void }) {
  const [focused, setFocused] = useState<StatsSessionRow | null>(null);
  const available = rows.filter((row) => row.running_ms !== null && row.running_ms > 0);
  if (!available.length) return <EmptyChart text="Для сравнения нужны задачи с наблюдавшимся Running" />;
  const width = 630, height = 230, left = 63, top = 16, right = 20, bottom = 36;
  const maxX = Math.max(...available.map((r) => r.running_ms ?? 0), 1) * 1.12, maxY = Math.max(...available.map((r) => r.tokens.total), 1) * 1.12, maxTurns = Math.max(...available.map((r) => r.turns), 1);
  const x = (n: number) => left + n / maxX * (width - left - right), y = (n: number) => height - bottom - n / maxY * (height - top - bottom);
  return <div>
    <div className="stats-chart-readout" aria-live="polite">{focused ? `${focused.title} · ${duration(focused.running_ms)} · ${tokens(focused.tokens.total)} токенов · ${focused.turns} ходов` : `Показано ${available.length} задач · размер точки — число ходов`}</div>
    <svg viewBox={`0 0 ${width} ${height}`} className="stats-chart" role="group" aria-label="Задачи: расход токенов и время Running">
      {[0, .25, .5, .75, 1].map((f) => <g key={f}><line x1={left} x2={width - right} y1={y(maxY * f)} y2={y(maxY * f)} className="stats-grid-line" /><text x={left - 8} y={y(maxY * f) + 4} textAnchor="end" className="stats-axis-text">{tokens(maxY * f)}</text><text x={x(maxX * f)} y={height - 15} textAnchor="middle" className="stats-axis-text">{duration(maxX * f)}</text></g>)}
      {available.map((row) => <circle key={row.id} cx={x(row.running_ms ?? 0)} cy={y(row.tokens.total)} r={4 + Math.sqrt(row.turns / maxTurns) * 9} fill={row.source === "codex" ? "#bc8cff" : "#58a6ff"} fillOpacity={focused?.id === row.id ? .95 : .5} stroke={focused?.id === row.id ? "#e6edf3" : row.source === "codex" ? "#bc8cff" : "#58a6ff"} strokeWidth="1" tabIndex={0} role="button" className="stats-svg-button" aria-label={`${row.title}. Running ${duration(row.running_ms)}, ${count(row.tokens.total)} токенов, ${row.turns} ходов. Открыть статистику задачи.`} onFocus={() => setFocused(row)} onBlur={() => setFocused(null)} onMouseEnter={() => setFocused(row)} onMouseLeave={() => setFocused(null)} onClick={() => onSelect(row.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.id); } }}><title>{row.title} · {duration(row.running_ms)} · {count(row.tokens.total)} токенов</title></circle>)}
      <text x={width / 2} y={height - 1} textAnchor="middle" className="stats-axis-text">Суммарное время Running</text>
    </svg>
    <div className="stats-legend"><span><i style={{ background: "#58a6ff" }} />OpenCode</span><span><i style={{ background: "#bc8cff" }} />Codex CLI</span></div>
  </div>;
}
