import { useEffect, useRef } from "react";
import { ArrowUpRight, Bot, Clock3, Loader2, X } from "lucide-react";
import type { StatsFilters, StatsSessionPayload, StatsSessionRow } from "@shared/usage";
import { serializeFilters } from "./filters";
import { cacheShare, count, dateLabel, duration, readable, sourceName, tokens, TOKEN_PARTS } from "./format";
import { useStatsRequest } from "./useStatsRequest";

function Timeline({ detail, timezone }: { detail: StatsSessionPayload; timezone: string }) {
  if (!detail.intervals.length) return <p className="stats-muted">В выбранном периоде интервалы Running не наблюдались.</p>;
  const from = Math.min(...detail.intervals.map((i) => i.start)), to = Math.max(...detail.intervals.map((i) => i.end));
  const span = Math.max(to - from, 1), participantMap = new Map(detail.participants.map((p) => [p.id, p]));
  const ids = [...new Set(detail.intervals.map((i) => i.session_id))];
  return <div className="stats-timeline">
    <div className="stats-timeline-axis"><span>{dateLabel(from, timezone, true)}</span><span>{dateLabel(to, timezone, true)}</span></div>
    {ids.map((id) => <div className="stats-timeline-row" key={id}><span className="stats-timeline-name" title={participantMap.get(id)?.title ?? id}>{participantMap.get(id)?.title ?? id}</span><div className="stats-timeline-track">{detail.intervals.filter((i) => i.session_id === id).map((interval, index) => <span key={index} className="stats-timeline-segment" tabIndex={0} aria-label={`${dateLabel(interval.start, timezone, true)} – ${dateLabel(interval.end, timezone, true)}, ${duration(interval.end - interval.start)}, ${readable(interval.agent ?? "")}, ${readable(interval.model ?? "")}`} title={`${dateLabel(interval.start, timezone, true)} – ${dateLabel(interval.end, timezone, true)} · ${duration(interval.end - interval.start)} · ${readable(interval.model ?? "")}`} style={{ left: `${(interval.start - from) / span * 100}%`, width: `${Math.max(0.15, (interval.end - interval.start) / span * 100)}%`, background: participantMap.get(id)?.source === "codex" ? "#bc8cff" : "#58a6ff" }} />)}</div></div>)}
    <p className="stats-note">Пустые участки — время без наблюдавшегося Running. Attention и IDLE сюда не входят.</p>
  </div>;
}
function Participant({ row, rootId, active, onBoard }: { row: StatsSessionRow; rootId: string; active: boolean; onBoard: (id: string) => void }) {
  return <article className="stats-participant">
    <div className="stats-participant-heading"><Bot size={15} className="stats-muted" /><span title={row.title}>{row.title}</span><span className="stats-small-tag">{row.id === rootId ? "Основная" : "Субагент"}</span>{active && <button type="button" onClick={() => onBoard(row.id)} title="Открыть карточку на доске" className="stats-icon-button"><ArrowUpRight size={15} /></button>}</div>
    <div className="stats-participant-meta"><span>{row.agents.map(readable).join(", ") || "Агент неизвестен"}</span><span>{row.models.map(readable).join(", ") || "Модель неизвестна"}</span></div>
    <div className="stats-participant-numbers"><span><b>{tokens(row.tokens.total)}</b> токенов</span><span><b>{duration(row.running_ms)}</b> Running</span><span><b>{row.calls}</b> вызовов</span><span><b>{row.turns}</b> ходов</span></div>
  </article>;
}
export function TaskDetail({ id, filters, refresh, activeSessionIds, onClose, onBoard }: { id: string; filters: StatsFilters; refresh: number; activeSessionIds: Set<string>; onClose: () => void; onBoard: (id: string) => void }) {
  const { data, pending, error } = useStatsRequest<StatsSessionPayload>(`/api/stats/session/${encodeURIComponent(id)}?${serializeFilters(filters)}`, refresh);
  const container = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = container.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handle);
    return () => { document.removeEventListener("keydown", handle); previous?.focus(); };
  }, [onClose]);
  const session = data?.session;
  return <div className="stats-detail-overlay" onClick={onClose}>
    <aside ref={container} className="stats-detail" role="dialog" aria-modal="true" aria-labelledby="stats-detail-title" onClick={(event) => event.stopPropagation()}>
      <header className="stats-detail-header"><div><span className="stats-eyebrow">Статистика задачи</span><h2 id="stats-detail-title">{session?.title ?? "Загрузка задачи…"}</h2></div><button ref={closeButton} type="button" className="stats-icon-button" onClick={onClose} aria-label="Закрыть статистику задачи"><X size={20} /></button></header>
      <div className="stats-detail-content">
        {error && <p role="alert" className="stats-error">{error}</p>}
        {pending && !data && <div className="stats-loading"><Loader2 size={22} className="animate-spin" />Загрузка статистики…</div>}
        {data && !session && <p className="stats-muted">Данных о задаче нет в выбранном периоде.</p>}
        {session && data && <>
          <div className="stats-detail-meta"><span className="stats-source-dot" data-source={session.source} />{sourceName(session.source)}<span>·</span><span title={session.directory}>{session.directory}</span></div>
          {activeSessionIds.has(id) && <button type="button" className="stats-button stats-button-primary" onClick={() => onBoard(id)}>Открыть на доске<ArrowUpRight size={15} /></button>}
          {session.incomplete && <p className="stats-warning-banner">Данные частичные: расход или время могли наблюдаться не полностью.</p>}
          <div className="stats-detail-kpis"><div><span>Токены</span><b title={count(session.tokens.total)}>{tokens(session.tokens.total)}</b></div><div><span>Сумма Running</span><b>{duration(session.running_ms)}</b></div><div><span>Активность задачи</span><b>{duration(session.active_ms)}</b></div><div><span>Вызовы / ходы</span><b>{count(session.calls)} / {count(session.turns)}</b></div></div>
          <section><h3>Расход токенов</h3><div className="stats-token-breakdown">{TOKEN_PARTS.map((part) => <div key={part.key}><span><i style={{ background: part.color }} />{part.label}</span><b>{count(session.tokens[part.key])}</b></div>)}</div><p className="stats-note">Доля кэша на входе: {cacheShare(session.tokens)}. Категории не пересекаются.</p></section>
          {(data.models.length > 0 || data.agents.length > 0) && <section><h3>Вклад моделей и агентов</h3><div className="stats-detail-breakdowns">{[{ label: "Модели", rows: data.models }, { label: "Агенты", rows: data.agents }].map(({ label, rows }) => <div key={label}><h4>{label}</h4>{rows.map((row) => <div key={row.key} className="stats-detail-breakdown-row"><span title={row.label}>{readable(row.label)}</span><b>{tokens(row.tokens.total)}</b><span>{duration(row.running_ms)}</span></div>)}</div>)}</div></section>}
          <section><h3>Участники задачи <span className="stats-count-badge">{data.participants.length}</span></h3><p className="stats-note">Вклад каждой сессии учитывается один раз. Указаны данные, попавшие под выбранные фильтры.</p><div className="stats-participants">{data.participants.map((row) => <Participant key={row.id} row={row} rootId={id} active={activeSessionIds.has(row.id)} onBoard={onBoard} />)}</div></section>
          <section><h3><Clock3 size={16} />Временная шкала Running</h3><Timeline detail={data} timezone={filters.timezone} /></section>
          {session.cost !== null && <section className="stats-price-note">Стоимость по данным источника: <b>{session.cost.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}</b><br /><span>{count(session.cost_calls)} из {count(session.calls)} вызовов содержат стоимость.</span></section>}
        </>}
      </div>
    </aside>
  </div>;
}
