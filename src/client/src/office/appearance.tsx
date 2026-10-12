import type { CardPayload } from "@shared/types";

const COLORS = ["#ed987f", "#8eb5ff", "#c3a0ef", "#8dd5ae", "#efd081", "#ed9dc5", "#85d5de"];

export function colorFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function modelName(card: CardPayload) {
  const model = (card.model_ref || card.context?.model)?.trim();
  return model ? model.slice(model.indexOf("/") + 1) : "Unknown model";
}

export function Mascot({ small = false }: { small?: boolean }) {
  return <g className={`office-mascot${small ? " office-mascot-small" : ""}`}>
    <g className="office-feet" fill="var(--resident-color)">
      <path d="M94 96h10v18H94zM114 96h10v18h-10zM134 96h10v18h-10z" />
    </g>
    <path fill="var(--resident-color)" d="M88 55h56v8h8v33h-8v8H88v-8h-8V63h8z" />
    <g fill="#19202b" className="office-eyes"><path d="M97 72h6v10h-6zM127 72h6v10h-6z" /></g>
    <path fill="#19202b" opacity=".35" d="M108 88h14v4h-14z" />
    <g fill="var(--resident-color)"><path className="office-arm-left" d="M72 76h8v20h-8z" />
      <path className="office-arm-right" d="M152 76h8v20h-8z" /></g>
  </g>;
}
