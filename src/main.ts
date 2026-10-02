import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import { FrameBuffer, decodeFrame, type SimFrame } from './link/frames';
import { createLink } from './link/link';
import { isTyping, type CameraPreset } from './render/camera';
import { HEAT_LABEL, HEAT_LAYERS, type HeatLayer } from './render/heatmap';
import { QualityGovernor, type QualityLevel } from './render/quality';
import { SceneView, type SceneOptions } from './render/scene';
import type { FailureKind } from './sim/failures';
import { createFloorGrid } from './sim/floor';
import { createDefaultLayout } from './sim/layout';
import { HEADER } from './sim/snapshot';
import { DEFAULT_CONFIG } from './sim/world';
import { Hud } from './ui/hud';
import { CpuHeatmap } from './render/heatmap-cpu';
import { SPEEDS, type SimCommand } from './worker/protocol';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLElement;
const loadingText = document.getElementById('loading-text') as HTMLElement;

function fail(message: string): never {
  loadingText.textContent = message;
  throw new Error(message);
}

let renderer: WebGLRenderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  fail(
    'Seu navegador não conseguiu iniciar o WebGL. Tente outro navegador ou ative a aceleração de hardware.',
  );
}
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

// The page builds the same static layout as the simulation (deterministic),
// so only dynamic state travels in the snapshots.
const layout = createDefaultLayout();
const grid = createFloorGrid(layout);
const laneNodes = (
  [
    ['A4', 'S1'],
    ['B3', 'B4'],
    ['B4', 'S2'],
  ] as const
).map(
  ([a, b]) =>
    [
      layout.graph.nodes.find((n) => n.name === a)!.id,
      layout.graph.nodes.find((n) => n.name === b)!.id,
    ] as const,
);
const sceneOptions: SceneOptions = {
  layout,
  grid,
  laneNodes,
  conveyorSpeed: DEFAULT_CONFIG.conveyorSpeed,
  truckAwayTime: DEFAULT_CONFIG.truckAwayTime,
};

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const hud = new Hud(grid);
const governor = new QualityGovernor('alta', (level) => applyQuality(level));
const link = createLink();
const frames = new FrameBuffer((buffer) => link.send({ type: 'release', buffer }, [buffer]));

let view!: SceneView;
let paused = false;
let speedIndex = 0;
let stress = false;
let heatIndex = 0;
let following = false;
let firstFrame: SimFrame | null = null;

// Main-thread responsiveness, for the worker vs inline comparison.
const longTasks = { count: 0, totalMs: 0 };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      longTasks.count++;
      longTasks.totalMs += e.duration;
    }
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // Long Tasks API not available (Firefox, Safari): the counter stays at 0.
}
const frameTimes: number[] = [];

function send(cmd: SimCommand) {
  link.send(cmd);
}

link.onMessage = (msg) => {
  if (msg.type === 'error') {
    console.error('Simulação:', msg.message);
    return;
  }
  const frame = decodeFrame(msg.buffer, msg.events);
  frames.push(frame);
  firstFrame ??= frame;
  if (msg.events.length) hud.pushEvents(msg.events, performance.now() / 1000);
};

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

function applyQuality(level: QualityLevel) {
  const { w, h } = viewport();
  view.applyQuality(level, w, h);
}

/** Builds a fresh view; the old view's GPU resources are released. */
function buildView() {
  view?.dispose();
  view = new SceneView(renderer, sceneOptions, canvas, motionQuery.matches);
  applyQuality(governor.level);
  view.setHeatLayer(HEAT_LAYERS[heatIndex] as HeatLayer);
  setCamera(following ? 'follow' : 'aerial');
}

function restart() {
  send({ type: 'restart' });
  hud.clearEvents();
  buildView();
}

function setCamera(preset: CameraPreset) {
  // Entering follow mode picks a robot that is actually working.
  if (preset === 'follow' && !following) view.nextFollow(frames.latest, false);
  following = preset === 'follow';
  view.setCameraPreset(preset);
  document.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.camera === preset));
  });
}

function sendSpeed() {
  send({ type: 'speed', speed: paused ? 0 : (SPEEDS[speedIndex] as number) });
  const label = `${SPEEDS[speedIndex]}×`;
  document.getElementById('speed-label')!.textContent = label;
}

function setPaused(v: boolean) {
  paused = v;
  const btn = document.getElementById('btn-pause') as HTMLButtonElement;
  btn.setAttribute('aria-pressed', String(v));
  btn.querySelector('.label')!.textContent = v ? 'Continuar' : 'Pausar';
  sendSpeed();
}

function changeSpeed(step: number) {
  speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, speedIndex + step));
  if (step > 0 && speedIndex === SPEEDS.length - 1 && paused) setPaused(false);
  sendSpeed();
}

function cycleSpeed() {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  sendSpeed();
}

function setStress(v: boolean) {
  stress = v;
  send({ type: 'stress', on: v });
  document.getElementById('btn-stress')!.setAttribute('aria-pressed', String(v));
}

function inject(kind: FailureKind) {
  send({ type: 'inject', kind });
}

function toggleAuto() {
  const on = !((frames.latest?.s.header[HEADER.autoFailures] ?? 0) > 0);
  send({ type: 'auto', on });
  document.getElementById('btn-auto')!.setAttribute('aria-pressed', String(on));
}

function cycleHeat() {
  heatIndex = (heatIndex + 1) % HEAT_LAYERS.length;
  const layer = HEAT_LAYERS[heatIndex] as HeatLayer;
  view.setHeatLayer(layer);
  document.getElementById('heat-label')!.textContent = HEAT_LABEL[layer];
  document.getElementById('btn-heat')!.setAttribute('aria-pressed', String(layer !== 'off'));
  const legend = document.getElementById('heat-legend') as HTMLElement;
  legend.hidden = layer === 'off';
  document.getElementById('heat-title')!.textContent = HEAT_LABEL[layer];
}

function toggleHelp(force?: boolean) {
  const help = document.getElementById('help') as HTMLElement;
  const open = force ?? help.hidden;
  help.hidden = !open;
  document.getElementById('btn-help')!.setAttribute('aria-expanded', String(open));
}

function nextRobot() {
  view.nextFollow(frames.latest);
  if (!following) setCamera('follow');
}

function bindControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach((b) => {
    b.addEventListener('click', () => setCamera(b.dataset.camera as CameraPreset));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-failure]').forEach((b) => {
    b.addEventListener('click', () => inject(b.dataset.failure as FailureKind));
  });
  document.getElementById('btn-pause')!.addEventListener('click', () => setPaused(!paused));
  document.getElementById('btn-speed')!.addEventListener('click', cycleSpeed);
  document.getElementById('btn-stress')!.addEventListener('click', () => setStress(!stress));
  document.getElementById('btn-restart')!.addEventListener('click', restart);
  document.getElementById('btn-auto')!.addEventListener('click', toggleAuto);
  document.getElementById('btn-heat')!.addEventListener('click', cycleHeat);
  document.getElementById('btn-quality')!.addEventListener('click', () => governor.cycle());
  document.getElementById('btn-help')!.addEventListener('click', () => toggleHelp());

  const failureKeys: Record<string, FailureKind> = {
    Digit5: 'conveyor',
    Digit6: 'surge',
    Digit7: 'robot',
    Digit8: 'dock',
  };
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    // Space/Enter on a focused button must keep activating that button.
    const onButton = e.target instanceof HTMLButtonElement;
    const failure = failureKeys[e.code];
    if (failure) {
      inject(failure);
      return;
    }
    switch (e.code) {
      case 'Digit1':
        setCamera('aerial');
        break;
      case 'Digit2':
        setCamera('ground');
        break;
      case 'Digit3':
        setCamera('follow');
        break;
      case 'KeyN':
        nextRobot();
        break;
      case 'Digit9':
        toggleAuto();
        break;
      case 'Space':
        if (onButton) return;
        e.preventDefault();
        setPaused(!paused);
        break;
      case 'Comma':
        changeSpeed(-1);
        break;
      case 'Period':
        changeSpeed(1);
        break;
      case 'KeyM':
        cycleHeat();
        break;
      case 'KeyT':
        setStress(!stress);
        break;
      case 'KeyG':
        governor.cycle();
        break;
      case 'KeyH':
        toggleHelp();
        break;
      case 'Escape':
        toggleHelp(false);
        break;
      case 'KeyR':
        if (e.shiftKey) restart();
        break;
    }
  });

  window.addEventListener('resize', () => {
    const { w, h } = viewport();
    view.resize(w, h);
  });
  motionQuery.addEventListener('change', () => view.setReducedMotion(motionQuery.matches));
}

let last = performance.now();
let hudTimer = 0;

function frame(now: number) {
  const realDt = Math.min((now - last) / 1000, 0.25);
  last = now;
  frameTimes.push(realDt * 1000);
  if (frameTimes.length > 3600) frameTimes.shift();
  const before = frames.renderTime;
  frames.advance(realDt);
  const simDt = Number.isNaN(before) ? 0 : Math.max(0, frames.renderTime - before);
  const sample = frames.sample();
  if (sample) view.update(realDt, sample.frame, sample.alpha, simDt);
  view.render();
  governor.frame(realDt);

  hudTimer -= realDt;
  if (hudTimer <= 0 && sample) {
    hudTimer = 0.2;
    hud.update(
      sample.frame,
      {
        fps: governor.fps,
        quality: governor.level,
        autoQuality: governor.auto,
        drawn: view.packets.visible,
        hidden: view.packets.hidden,
        simMode: link.mode,
        followed: following ? view.followRobot : null,
      },
      now / 1000,
    );
    const auto = (sample.frame.s.header[HEADER.autoFailures] as number) > 0;
    document.getElementById('btn-auto')!.setAttribute('aria-pressed', String(auto));
  }
  requestAnimationFrame(frame);
}

async function boot() {
  // Canvas-drawn labels need the web font loaded before they are rasterized.
  await Promise.all([
    document.fonts.load('700 64px "Barlow Condensed"'),
    document.fonts.load('500 16px "JetBrains Mono"'),
  ]).catch(() => undefined);
  send({ type: 'init', config: { seed: DEFAULT_CONFIG.seed } });
  buildView();
  bindControls();
  // Wait for the first snapshot, render once (shaders compile behind the loading screen), reveal.
  const started = performance.now();
  while (!firstFrame && performance.now() - started < 10_000) {
    await new Promise((r) => setTimeout(r, 16));
  }
  if (!firstFrame) fail('A simulação não respondeu. Recarregue a página.');
  frames.advance(0);
  const sample = frames.sample();
  if (sample) view.update(0, sample.frame, sample.alpha, 0);
  view.render();
  loading.classList.add('is-done');
  last = performance.now();
  requestAnimationFrame(frame);
}

// Read-only handle for automated checks (performance, memory and screenshots).
Object.defineProperty(window, '__gemeo', {
  value: {
    get frames() {
      return frames;
    },
    get view() {
      return view;
    },
    get governor() {
      return governor;
    },
    renderer: () => renderer,
    link,
    send,
    longTasks,
    frameTimes,
    /**
     * CPU milliseconds per frame of the heat map: the GPU version (upload
     * positions + two render passes) against the CPU reference (rasterize
     * splats and upload a float texture). Average over `n` frames each.
     */
    benchHeat(n = 120) {
      const frame = frames.latest;
      if (!frame) return null;
      const dt = 1 / 60;
      // The page clock is coarse (about 0.1 ms), so time n frames in a row and divide.
      const ref = new CpuHeatmap(layout.bounds);
      let t = performance.now();
      for (let i = 0; i < n; i++) view.heat.update(frame, 1, view.poses, dt);
      const gpuMs = (performance.now() - t) / n;
      t = performance.now();
      for (let i = 0; i < n; i++) {
        ref.update(frame, 1, view.poses, dt, view.heat.piles);
        renderer.initTexture(ref.texture);
      }
      const cpuMs = (performance.now() - t) / n;
      ref.texture.dispose();
      return {
        gpuMs,
        cpuMs,
        packets: frame.s.header[HEADER.packets],
        robots: frame.s.header[HEADER.robots],
        texels: ref.width * ref.height,
      };
    },
    /** Named header fields of the newest snapshot. */
    header() {
      const h = frames.latest?.s.header;
      if (!h) return null;
      return Object.fromEntries(Object.entries(HEADER).map(([k, i]) => [k, h[i]]));
    },
  },
});

void boot();
