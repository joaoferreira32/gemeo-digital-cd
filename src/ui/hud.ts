import type { FloorGrid } from '../sim/floor';
import type { SimEvent } from '../sim/failures';
import type { RobotStage } from '../sim/fleet';
import { STAGE_LABEL } from '../sim/labels';
import { HEADER, JOBS, ROBOT, ROBOT_STRIDE, STAGES } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { QUALITY_LABEL, type QualityLevel } from '../render/quality';
import { formatClock, formatInt, formatRate, formatSeconds } from './format';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

export { STAGE_LABEL };

export interface RenderStats {
  fps: number;
  quality: QualityLevel;
  autoQuality: boolean;
  drawn: number;
  hidden: number;
  simMode: 'worker' | 'inline';
  /** Robot shown in the follow panel, or null when not following. */
  followed: number | null;
}

/** Seconds an event stays in the on-screen feed. */
const EVENT_SECONDS = 7;

/**
 * Heads-up display. Every number comes from the simulation snapshot or from
 * the renderer's own counters (FPS, drawn instances) — nothing is computed
 * or invented here beyond formatting.
 */
export class Hud {
  private readonly clock = el('sim-clock');
  private readonly state = el('sim-state');
  private readonly speed = el('sim-speed');
  private readonly seed = el('sim-seed');
  private readonly waiting = el('m-waiting');
  private readonly waitingSub = el('m-waiting-sub');
  private readonly delivered = el('m-delivered');
  private readonly deliveredSub = el('m-delivered-sub');
  private readonly cycle = el('m-cycle');
  private readonly throughput = el('m-throughput');
  private readonly fleet = el('m-fleet');
  private readonly fps = el('p-fps');
  private readonly quality = el('p-quality');
  private readonly qualityMode = el('p-quality-mode');
  private readonly drawn = el('p-drawn');
  private readonly hiddenRow = el('p-hidden-row');
  private readonly hidden = el('p-hidden');
  private readonly sim = el('p-sim');
  private readonly events = el<HTMLOListElement>('events');
  private readonly panel = el('robot-panel');
  private readonly rName = el('r-name');
  private readonly rState = el('r-state');
  private readonly rBattery = el('r-battery');
  private readonly rBatteryFill = el('r-battery-fill');
  private readonly rBatteryMeter = el('r-battery-meter');
  private readonly rLoad = el('r-load');
  private readonly rTask = el('r-task');
  private readonly rRoute = el('r-route');
  private readonly rSpeed = el('r-speed');
  private readonly shown: { node: HTMLLIElement; until: number }[] = [];

  constructor(private readonly grid: FloorGrid) {}

  /** Writes text only when it changed, to avoid needless layout work. */
  private set(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  update(frame: SimFrame, render: RenderStats, now: number): void {
    const h = frame.s.header;
    const v = (k: keyof typeof HEADER) => h[HEADER[k]] as number;
    const speed = v('speed');
    this.set(this.clock, formatClock(v('time')));
    this.set(this.seed, `seed ${v('seed')}`);
    this.state.dataset.state = speed === 0 ? 'paused' : 'running';
    this.set(this.state, speed === 0 ? 'Pausado' : 'Rodando');
    this.set(this.speed, speed === 0 ? '' : `${speed}×`);

    const waiting = v('waiting');
    const backlog = v('backlog');
    const bypass = v('inBypass');
    this.set(this.waiting, formatInt(waiting));
    this.set(
      this.waitingSub,
      `entrada ${formatInt(backlog)} · parados ${formatInt(Math.max(0, waiting - backlog))}` +
        (bypass > 0 ? ` · desvio ${formatInt(bypass)}` : ''),
    );
    this.set(this.delivered, formatInt(v('delivered')));
    this.set(
      this.deliveredSub,
      `expedidos ${formatInt(v('shipped'))} · por robôs ${formatInt(v('deliveredByRobots'))}`,
    );
    this.set(this.cycle, formatSeconds(v('windowCycle')));
    this.set(this.throughput, formatRate(v('throughput')));
    this.set(
      this.fleet,
      `Robôs: ${formatInt(v('robotsWorking'))} em tarefa · ${formatInt(v('robotsCharging'))} recarregando · ` +
        `${formatInt(v('robotsIdle'))} parados` +
        (v('robotsDefect') > 0 ? ` · ${formatInt(v('robotsDefect'))} com defeito` : ''),
    );

    this.set(this.fps, render.fps > 0 ? formatInt(render.fps) : '—');
    this.set(this.quality, QUALITY_LABEL[render.quality]);
    this.set(this.qualityMode, render.autoQuality ? '(auto)' : '(manual)');
    this.set(this.drawn, formatInt(render.drawn));
    this.hiddenRow.hidden = render.hidden === 0;
    this.set(this.hidden, formatInt(render.hidden));
    this.set(this.sim, render.simMode === 'worker' ? 'Web Worker' : 'thread principal');

    this.updateRobot(frame, render.followed);
    this.expireEvents(now);
  }

  private updateRobot(frame: SimFrame, index: number | null): void {
    const count = frame.s.header[HEADER.robots] as number;
    this.panel.hidden = index === null || index >= count;
    if (index === null || index >= count) return;
    const r = frame.s.robots;
    const o = index * ROBOT_STRIDE;
    const stage = STAGES[r[o + ROBOT.stage] as number] as RobotStage;
    const battery = r[o + ROBOT.battery] as number;
    const load = r[o + ROBOT.load] as number;
    const waiting = r[o + ROBOT.waiting] as number;
    this.set(this.rName, `Robô ${index + 1}`);
    const note =
      waiting === 1
        ? ' · aguardando a estação'
        : waiting === 2
          ? ' · replanejando'
          : waiting === 3
            ? ' · travado, sem caminho'
            : '';
    this.set(this.rState, STAGE_LABEL[stage] + note);
    this.rState.dataset.stage = stage;
    this.set(this.rBattery, `${formatInt(battery)}%`);
    this.rBatteryFill.style.width = `${Math.max(0, Math.min(100, battery))}%`;
    this.rBatteryFill.dataset.low = String(battery < 25);
    this.rBatteryMeter.setAttribute('aria-valuenow', String(Math.round(battery)));
    this.set(
      this.rLoad,
      load === 0 ? 'vazio' : load === 1 ? '1 caixa' : `${formatInt(load)} caixas`,
    );
    const job = JOBS[r[o + ROBOT.job] as number] ?? 'none';
    const station = this.grid.stations[r[o + ROBOT.station] as number];
    const target = station ? station.label : '—';
    const task =
      job === 'rack'
        ? `Pedido de estoque · ${target}`
        : job === 'bypass'
          ? `Desvio de esteira · ${target}`
          : job === 'charge'
            ? target
            : job === 'park'
              ? `Voltar à ${target.toLowerCase()}`
              : job === 'goto'
                ? 'Deslocamento programado'
                : stage === 'parked'
                  ? 'Sem tarefa'
                  : '—';
    this.set(this.rTask, task);
    const cells = r[o + ROBOT.routeLength] as number;
    const stepSeconds = frame.s.header[HEADER.stepSeconds] as number;
    const eta = Math.max(0, (r[o + ROBOT.planEnd] as number) * stepSeconds - frame.time);
    this.set(
      this.rRoute,
      cells > 1 ? `${formatInt(cells - 1)} células · chega em ${formatSeconds(eta)}` : 'parado',
    );
    this.set(this.rSpeed, `${formatRate(r[o + ROBOT.speed] as number)} m/s`);
  }

  /** Shows new events in the on-screen feed (newest at the bottom, at most four). */
  pushEvents(events: readonly SimEvent[], now: number): void {
    for (const e of events) {
      const li = document.createElement('li');
      li.textContent = e.text;
      li.dataset.kind = e.kind;
      if (e.failure) li.dataset.failure = e.failure;
      this.events.append(li);
      this.shown.push({ node: li, until: now + EVENT_SECONDS });
    }
    while (this.shown.length > 4) this.shown.shift()?.node.remove();
  }

  private expireEvents(now: number): void {
    while (this.shown.length && (this.shown[0] as { until: number }).until <= now) {
      this.shown.shift()?.node.remove();
    }
  }

  clearEvents(): void {
    for (const s of this.shown) s.node.remove();
    this.shown.length = 0;
  }
}
