import type { SimEvent } from './failures';
import { ROBOT_STAGES } from './fleet';
import { EVENT_LABEL, STAGE_LABEL } from './labels';
import type { Recorder } from './recorder';

/** A spreadsheet in Portuguese reads these as numbers: decimal comma, no thousands separator. */
function seconds(t: number): string {
  return t.toFixed(2).replace('.', ',');
}

function cell(v: string): string {
  return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** "Robô 3", "Esteira 7 (A1→A2)", "Doca 2" for an entity key of `SimEvent.about`. */
export function entityLabel(rec: Recorder, key: string): string {
  const [kind, id] = key.split(':') as [string, string];
  const n = Number(id);
  if (kind === 'robot') return `Robô ${n + 1}`;
  if (kind === 'dock') return `Doca ${n + 1}`;
  if (kind === 'conveyor') return rec.live.conveyorLabel(n);
  return key;
}

/**
 * The domain event log of the recording as CSV, ready for a spreadsheet in
 * Portuguese (UTF-8 with BOM, ";" between columns, decimal comma): every
 * event of the feed and every robot stage change, in time order.
 */
export function eventLogCsv(rec: Recorder): string {
  const lines = ['tempo_s;tipo;entidade;descricao'];
  const eventRow = (e: SimEvent) =>
    [
      seconds(e.time),
      EVENT_LABEL[e.kind],
      (e.about ?? []).map((k) => entityLabel(rec, k)).join(', '),
      e.text,
    ]
      .map(cell)
      .join(';');
  const dt = rec.config.dt;
  const j = rec.journal;
  let e = 0;
  for (let i = 0; i < j.length; i++) {
    const t = j.ticks.get(i) * dt;
    // Events first when both happen at the same instant (a failure, then its effect).
    while (e < rec.events.length && (rec.events[e] as SimEvent).time <= t + 1e-9) {
      lines.push(eventRow(rec.events[e++] as SimEvent));
    }
    const stage = ROBOT_STAGES[j.stages.get(i)] ?? 'parked';
    lines.push(
      [seconds(t), 'Estado do robô', `Robô ${j.robots.get(i) + 1}`, STAGE_LABEL[stage]]
        .map(cell)
        .join(';'),
    );
  }
  while (e < rec.events.length) lines.push(eventRow(rec.events[e++] as SimEvent));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
