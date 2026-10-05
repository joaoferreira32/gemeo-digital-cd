import type { FailureKind, SimEvent, SimEventKind } from '../sim/failures';
import { ROBOT_STAGES } from '../sim/fleet';
import { entityLabel } from '../sim/export';
import { STAGE_LABEL } from '../sim/labels';
import type { Recorder } from '../sim/recorder';

/**
 * What the page shows about the recording, computed in the worker from the
 * recorder: the timeline strip and markers, and the history of an entity.
 * Pure functions of the recorder, so they are tested without a browser.
 */

export type MarkerKind = FailureKind | 'stuck' | 'watchdog' | 'maintenance';

export interface TimelineMarker {
  readonly kind: MarkerKind;
  /** Seconds; `end` is null while it lasts at the head of the recording. */
  readonly start: number;
  readonly end: number | null;
  readonly label: string;
}

export interface Timeline {
  /** Seconds at the head of the recording (the live world) and of the moment shown. */
  readonly head: number;
  readonly shown: number;
  readonly viewing: boolean;
  /** Still replaying toward the moment asked for. */
  readonly seeking: boolean;
  /** Packets waiting over the whole recording: the largest value in each bucket. */
  readonly strip: number[];
  readonly stripMax: number;
  readonly markers: TimelineMarker[];
  /** Seconds at which the run was continued from the past. */
  readonly branches: number[];
  readonly memoryMB: number;
}

export function timeline(rec: Recorder, buckets = 400): Timeline {
  const dt = rec.config.dt;
  const s = rec.series;
  const n = Math.max(1, Math.min(buckets, s.seconds));
  const strip = new Array<number>(n).fill(0);
  for (let sec = 0; sec < s.seconds; sec++) {
    const b = Math.min(n - 1, Math.floor((sec * n) / s.seconds));
    strip[b] = Math.max(strip[b] as number, s.waiting.get(sec));
  }
  return {
    head: rec.headTick * dt,
    shown: rec.shown.tick * dt,
    viewing: rec.viewing,
    seeking: rec.seeking,
    strip,
    stripMax: Math.max(1, ...strip),
    markers: markers(rec.events),
    branches: rec.branches.map((t) => t * dt),
    memoryMB: rec.memoryBytes / 2 ** 20,
  };
}

/** Failures and stuck robots as intervals (start event paired with its end); watchdog actions and maintenance alarms as points. */
export function markers(events: readonly SimEvent[]): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  const open = new Map<string, number>();
  const close = (key: string, time: number) => {
    const i = open.get(key);
    if (i === undefined) return;
    out[i] = { ...(out[i] as TimelineMarker), end: time };
    open.delete(key);
  };
  for (const e of events) {
    if (e.kind === 'failure-start' && e.failure) {
      open.set(`${e.failure}:${e.target}`, out.length);
      out.push({ kind: e.failure, start: e.time, end: null, label: e.text });
    } else if (e.kind === 'failure-end' && e.failure) {
      close(`${e.failure}:${e.target}`, e.time);
    } else if (e.kind === 'robot-stuck') {
      open.set(`stuck:${e.about?.[0]}`, out.length);
      out.push({ kind: 'stuck', start: e.time, end: null, label: e.text });
    } else if (e.kind === 'robot-moving') {
      close(`stuck:${e.about?.[0]}`, e.time);
    } else if (e.kind === 'watchdog' || e.kind === 'maintenance') {
      out.push({ kind: e.kind, start: e.time, end: e.time, label: e.text });
    }
  }
  return out;
}

export interface EntityHistory {
  readonly entity: string;
  readonly kind: 'robot' | 'conveyor' | 'dock';
  readonly label: string;
  /** Second of the recording it describes. */
  readonly at: number;
  /** One line about it right now (pt-BR). */
  readonly status: string;
  /** 0 … 1 over the window: busy time (robot), flow ÷ capacity (belt), deliveries ÷ service rate (dock). */
  readonly use: number;
  readonly windowSeconds: number;
  /**
   * One value per second of the window, oldest first: the stage index of a
   * robot, packets that left a belt or reached a dock during that second.
   */
  readonly series: number[];
  readonly events: { time: number; kind: SimEventKind; text: string }[];
}

export function history(rec: Recorder, entity: string, window = 300): EntityHistory {
  const [kind, idText] = entity.split(':') as [string, string];
  const id = Number(idText);
  const w = rec.shown;
  const s = rec.series;
  const at = Math.max(0, Math.min(s.seconds - 1, Math.floor(w.time + 1e-9)));
  const k = rec.kpis(at, window);
  const series = new Array<number>(window).fill(0);
  let status: string;
  let use: number;

  if (kind === 'robot') {
    const r = w.fleet?.robots[id];
    if (!r) throw new Error(`no robot ${id}`);
    use = k.robotUse[id] ?? 0;
    const load = r.load.length;
    status =
      `${STAGE_LABEL[r.stage]} · ${load === 0 ? 'vazio' : load === 1 ? '1 caixa' : `${load} caixas`}` +
      ` · bateria ${Math.round(r.battery)}%`;
    // Stage at every second of the window, from the logged stage changes.
    const j = rec.journal;
    const perSecond = Math.round(1 / rec.config.dt);
    let stage = ROBOT_STAGES.indexOf('parked');
    let i = 0;
    const firstTick = (at - window + 1) * perSecond;
    for (; i < j.length && j.ticks.get(i) <= firstTick; i++) {
      if (j.robots.get(i) === id) stage = j.stages.get(i);
    }
    for (let x = 0; x < window; x++) {
      const tick = (at - window + 1 + x) * perSecond;
      for (; i < j.length && j.ticks.get(i) <= tick; i++) {
        if (j.robots.get(i) === id) stage = j.stages.get(i);
      }
      series[x] = tick < 0 ? -1 : stage;
    }
  } else if (kind === 'conveyor') {
    const c = w.conveyors[id];
    if (!c) throw new Error(`no conveyor ${id}`);
    use = k.conveyorUse[id] ?? 0;
    let blocked = 0;
    for (const p of c.packets) if (p.blocked) blocked++;
    const one = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    const h = w.health;
    status =
      `${c.status === 'ok' ? 'Funcionando' : 'Quebrada'} · ${c.packets.length} pacotes` +
      (blocked ? `, ${blocked} parados` : '') +
      ` · motor ${one(h.vibration[id] as number)} mm/s, ${one(h.temperature[id] as number)} °C` +
      (h.alarm[id] ? ' · alarme de manutenção' : '');
    for (let x = 0; x < window; x++) {
      const sec = at - window + 1 + x;
      if (sec < 1) continue;
      series[x] =
        s.conveyorExits.get(sec * s.conveyors + id) -
        s.conveyorExits.get((sec - 1) * s.conveyors + id);
    }
  } else if (kind === 'dock') {
    const d = w.docks[id];
    if (!d) throw new Error(`no dock ${id}`);
    use = k.dockUse[id] ?? 0;
    const truck =
      d.truck.state === 'away'
        ? `caminhão volta em ${Math.ceil(d.truck.awayLeft)} s`
        : d.truck.state === 'loading'
          ? `caminhão carregando (${d.truck.load}/${w.config.truckCapacity})`
          : 'caminhão esperando carga';
    status = `${d.blockedUntil > w.time ? 'Bloqueada · ' : ''}${d.staged.length} pacotes na área · ${truck}`;
    for (let x = 0; x < window; x++) {
      const sec = at - window + 1 + x;
      if (sec < 1) continue;
      series[x] =
        s.dockDeliveries.get(sec * s.docks + id) - s.dockDeliveries.get((sec - 1) * s.docks + id);
    }
  } else {
    throw new Error(`unknown entity ${entity}`);
  }

  const events: EntityHistory['events'] = [];
  for (let e = rec.events.length - 1; e >= 0 && events.length < 10; e--) {
    const ev = rec.events[e] as SimEvent;
    if (ev.time > w.time + 1e-9 || !ev.about?.includes(entity)) continue;
    events.push({ time: ev.time, kind: ev.kind, text: ev.text });
  }
  return {
    entity,
    kind,
    label: entityLabel(rec, entity),
    at,
    status,
    use,
    windowSeconds: window,
    series,
    events,
  };
}
