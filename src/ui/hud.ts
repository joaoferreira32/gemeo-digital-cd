import type { World } from '../sim/world';
import { QUALITY_LABEL, type QualityLevel } from '../render/quality';
import { formatClock, formatInt, formatRate, formatSeconds } from './format';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

export interface RenderStats {
  fps: number;
  quality: QualityLevel;
  autoQuality: boolean;
  drawn: number;
  hidden: number;
  followedId: number | null;
}

/**
 * Heads-up display. Every number comes from the simulation (World) or from
 * the renderer's own counters (FPS, drawn instances) — nothing is computed
 * or invented here beyond formatting.
 */
export class Hud {
  private readonly clock = el('sim-clock');
  private readonly state = el('sim-state');
  private readonly seed = el('sim-seed');
  private readonly waiting = el('m-waiting');
  private readonly waitingSub = el('m-waiting-sub');
  private readonly delivered = el('m-delivered');
  private readonly deliveredSub = el('m-delivered-sub');
  private readonly cycle = el('m-cycle');
  private readonly cycleSub = el('m-cycle-sub');
  private readonly throughput = el('m-throughput');
  private readonly fps = el('p-fps');
  private readonly quality = el('p-quality');
  private readonly qualityMode = el('p-quality-mode');
  private readonly drawn = el('p-drawn');
  private readonly hiddenRow = el('p-hidden-row');
  private readonly hidden = el('p-hidden');
  private readonly follow = el('p-follow');
  private readonly followId = el('p-follow-id');

  /** Writes text only when it changed, to avoid needless layout work. */
  private set(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  update(world: World, paused: boolean, render: RenderStats): void {
    const { stats, metrics } = world;
    const now = world.time;
    this.set(this.clock, formatClock(now));
    this.set(this.seed, `seed ${world.config.seed}`);
    this.state.dataset.state = paused ? 'paused' : 'running';
    this.set(this.state, paused ? 'Pausado' : 'Rodando');

    this.set(this.waiting, formatInt(stats.waiting));
    this.set(
      this.waitingSub,
      `entrada ${formatInt(stats.backlog)} · parados ${formatInt(stats.waiting - stats.backlog)}`,
    );
    this.set(this.delivered, formatInt(metrics.delivered));
    this.set(this.deliveredSub, `expedidos ${formatInt(metrics.shipped)}`);
    this.set(this.cycle, formatSeconds(metrics.windowMeanCycleTime));
    this.set(this.cycleSub, `últimos ${formatInt(metrics.windowSeconds)} s simulados`);
    this.set(this.throughput, formatRate(metrics.throughputPerMinute(now)));

    this.set(this.fps, render.fps > 0 ? formatInt(render.fps) : '—');
    this.set(this.quality, QUALITY_LABEL[render.quality]);
    this.set(this.qualityMode, render.autoQuality ? '(auto)' : '(manual)');
    this.set(this.drawn, formatInt(render.drawn));
    // Packets that exist in the simulation but exceed the pile slots drawn on the floor.
    this.hiddenRow.hidden = render.hidden === 0;
    this.set(this.hidden, formatInt(render.hidden));
    this.follow.hidden = render.followedId === null;
    if (render.followedId !== null) this.set(this.followId, `#${render.followedId}`);
  }
}
