import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
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
import { HistoryPanel } from './ui/history';
import { KpiPanel } from './ui/kpi';
import { adaptWorker } from './lab/pool';
import { LabPanel } from './ui/lab';
import { pickEntity } from './ui/pick';
import { SHORTCUTS, shortcutFor } from './ui/shortcuts';
import { TimelineBar } from './ui/timeline';
import type { RunReport } from './sim/recorder';
import { chooseFormat, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, VideoCapture } from './demo/capture';
import { mp4Frames, type Mp4Frames } from './demo/mp4';
import { Director, type DirectorStage } from './demo/director';
import { drawOverlay, type OverlayState } from './demo/overlay';
import { CpuHeatmap } from './render/heatmap-cpu';
import { SPEEDS, type RoutingStatus, type SimCommand } from './worker/protocol';
import { POLICY_CHOICES, type PolicyChoice } from './worker/routing';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const overlayCanvas = document.getElementById('demo-overlay') as HTMLCanvasElement;
const overlay = overlayCanvas.getContext('2d') as CanvasRenderingContext2D;
const demoBar = document.getElementById('demo-bar') as HTMLElement;
const demoNote = document.getElementById('demo-note') as HTMLElement;
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
const kpiPanel = new KpiPanel(document.getElementById('kpi-panel') as HTMLElement, layout);
const historyPanel = new HistoryPanel(document.getElementById('history-panel') as HTMLElement);
const labPanel = new LabPanel(document.getElementById('lab-panel') as HTMLElement, {
  conveyorLabels: layout.graph.edges.map(
    (e) => `${e.name} (${layout.graph.node(e.from).name}→${layout.graph.node(e.to).name})`,
  ),
  modelUrl: new URL('models/roteamento', document.baseURI).href,
  demandUrl: new URL('demanda-olist.json', document.baseURI).href,
  spawn: () =>
    adaptWorker(new Worker(new URL('./lab/lab.worker.ts', import.meta.url), { type: 'module' })),
  cores: navigator.hardwareConcurrency || 4,
});
const timeline = new TimelineBar(document.getElementById('timeline') as HTMLElement, {
  seek: (time) => send({ type: 'seek', time }),
  live: () => send({ type: 'live' }),
  branch: () => continueHere(),
  exportCsv: () => send({ type: 'export', what: 'csv' }),
  exportReport: () => send({ type: 'export', what: 'report' }),
  loadReport: (file) => void loadReport(file),
});

let view!: SceneView;
let paused = false;
let speedIndex = 0;
let stress = false;
let heatIndex = 0;
let following = false;
let firstFrame: SimFrame | null = null;
let routing: RoutingStatus | null = null;
/** The video being recorded (the demo with ⇧V), or null. */
let capture: VideoCapture | null = null;
/** The last video recorded: its format, size and frames drawn (automated checks). */
let lastVideo: { label: string; bytes: number; drawn: number; file: Mp4Frames | null } | null =
  null;

/** What the demo's director moves: the scene's camera, depth of field, heat map, robots. */
const stage: DirectorStage = {
  aim: (target, radius, phi, theta) => view.orbit.aim(target, radius, phi, theta),
  focus: (on) => view.setFocus(on ? view.orbit.distance : null),
  heat: (layer) => view.setHeatLayer(layer),
  robot: (pick) => {
    if (pick) view.nextFollow(frames.latest, false);
    const n = view.poses.count;
    if (n === 0) return null;
    const r = Math.min(view.followRobot, n - 1);
    return { x: view.poses.x[r] as number, z: view.poses.z[r] as number };
  },
  send: (cmd) => send(cmd),
};
const director = new Director(stage, layout, () => motionQuery.matches);

const POLICY_LABEL: Record<PolicyChoice, string> = {
  static: 'Estático',
  heuristic: 'Heurística',
  rl: 'IA (PPO)',
};

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
  switch (msg.type) {
    case 'snapshot': {
      const frame = decodeFrame(msg.buffer, msg.events);
      // Entering the past: the feed showed what happened later; it starts over.
      if (frame.mode === 1 && (frames.latest?.mode ?? 0) === 0) hud.clearEvents();
      frames.push(frame);
      firstFrame ??= frame;
      if (msg.events.length) hud.pushEvents(msg.events, performance.now() / 1000);
      director.onEvents(msg.events);
      return;
    }
    case 'status':
      timeline.update(msg.timeline);
      kpiPanel.update(msg.kpis, msg.stages, msg.timeline.shown, msg.timeline.viewing);
      showRouting(msg.routing);
      hud.showBottleneck(msg.bottleneck);
      director.onBottleneck(msg.bottleneck);
      view.setBottleneck(msg.bottleneck);
      kpiPanel.updateMaintenance(msg.maintenance);
      return;
    case 'history':
      historyPanel.render(msg.history);
      return;
    case 'export':
      download(msg.filename, msg.mime, msg.text);
      return;
    case 'replay':
      showReplay(msg.progress, msg.done, msg.ok);
      return;
    case 'demo':
      director.onDemo(msg);
      return;
    case 'error':
      console.error('Simulação:', msg.message);
      note(msg.message);
      return;
  }
};

/** A line in the event feed from the page itself (not from the simulation). */
function note(text: string) {
  hud.pushEvents([{ id: -1, time: 0, kind: 'watchdog', text }], performance.now() / 1000);
}

function download(filename: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadReport(file: File) {
  try {
    const report = JSON.parse(await file.text()) as RunReport;
    hud.clearEvents();
    historyPanel.close();
    send({ type: 'load-report', report });
    note(`Reproduzindo o relatório ${file.name}…`);
  } catch {
    note('Não foi possível ler esse arquivo como relatório.');
  }
}

let replayNoted = 0;
function showReplay(progress: number, done: boolean, ok?: boolean) {
  if (done) {
    replayNoted = 0;
    setPaused(true);
    note(
      ok
        ? 'Relatório reproduzido: o estado final bate com o da gravação original (mesma impressão digital).'
        : 'Relatório reproduzido, mas o estado final difere do original.',
    );
    return;
  }
  const step = Math.floor(progress * 4);
  if (step > replayNoted) {
    replayNoted = step;
    note(`Reproduzindo relatório: ${Math.round(progress * 100)}%`);
  }
}

/** Continues the run from the moment shown (the future that was recorded is dropped). */
function continueHere() {
  if (!timeline.viewing) return;
  send({ type: 'branch' });
  if (paused) setPaused(false);
  note('A simulação continua daqui; o que vinha depois foi descartado.');
}

function seekBy(seconds: number) {
  const from = timeline.viewing ? timeline.shown : timeline.head;
  send({ type: 'seek', time: Math.max(0, Math.min(timeline.head, from + seconds)) });
}

function openHistory(entity: string) {
  historyPanel.show(entity);
  document.getElementById('robot-panel')!.hidden = true;
  send({ type: 'history', entity });
}

function toggleKpi(force?: boolean) {
  kpiPanel.toggle(force);
}

/** The size the scene draws at: the window, or exactly the video's while recording. */
function viewport() {
  return capture
    ? { w: VIDEO_WIDTH, h: VIDEO_HEIGHT }
    : { w: window.innerWidth, h: window.innerHeight };
}

function applyQuality(level: QualityLevel) {
  const { w, h } = viewport();
  view.applyQuality(level, w, h, capture ? 1 : undefined);
}

/**
 * The demo (V), or the demo recorded to a video file (⇧V): the page shows the
 * scene and the captions only, and the director plays the script.
 */
function startDemo(record: boolean) {
  if (director.active) endDemo();
  if (record) {
    const format =
      typeof MediaRecorder === 'undefined'
        ? null
        : chooseFormat((mime) => MediaRecorder.isTypeSupported(mime));
    if (!format) {
      note(
        'Este navegador não grava vídeo a partir da página (MediaRecorder): a demo roda sem gravar.',
      );
    } else {
      capture = new VideoCapture(format);
      document.body.classList.add('recording');
      governor.hold('alta');
      demoNote.textContent =
        `Gravando em ${format.label}, ${VIDEO_WIDTH}×${VIDEO_HEIGHT}, ${VIDEO_FPS} FPS. ` +
        (format.warning ?? 'O arquivo é baixado no fim.');
    }
  }
  if (!capture) demoNote.textContent = '';
  hud.clearEvents();
  historyPanel.close();
  labPanel.toggle(false);
  toggleHelp(false);
  kpiPanel.toggle(false);
  document.body.classList.add('demo-mode');
  overlayCanvas.hidden = false;
  demoBar.hidden = false;
  buildView();
  director.start();
}

/** Back to the ordinary app: a fresh run, the panels and the settings of before. */
function endDemo() {
  director.stop();
  if (capture) {
    void capture.stop();
    capture = null;
    note('Gravação interrompida: o vídeo não foi salvo.');
  }
  leaveDemo();
}

function leaveDemo() {
  document.body.classList.remove('demo-mode', 'recording');
  overlayCanvas.hidden = true;
  demoBar.hidden = true;
  governor.hold(null);
  send({ type: 'init', config: { seed: DEFAULT_CONFIG.seed, scheduleMaintenance: true } });
  hud.clearEvents();
  buildView();
  sendSpeed();
  if (paused) setPaused(true);
}

/** The recording reached the end of the card: the file is saved, then back to the app. */
async function finishRecording() {
  const c = capture as VideoCapture;
  capture = null;
  director.stop();
  const blob = await c.stop();
  const name = `gemeo-digital-demo.${c.format.ext}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  // The frames the file really holds (an MP4 is read box by box; a WebM is not counted).
  const file = c.format.ext === 'mp4' ? mp4Frames(new Uint8Array(await blob.arrayBuffer())) : null;
  lastVideo = { label: c.format.label, bytes: blob.size, drawn: c.drawn, file };
  leaveDemo();
  const mb = (blob.size / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const one = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const frames = file
    ? ` ${file.frames.toLocaleString('pt-BR')} quadros em ${one(file.seconds)} s (${one(file.fps)} FPS).`
    : '';
  note(
    `Vídeo salvo: ${name} (${c.format.label}, ${mb} MB).${frames}` +
      (c.format.warning ? ` ${c.format.warning}` : ''),
  );
}

/** Draws the demo's captions over the scene, at the size the overlay canvas has on screen. */
function drawDemoOverlay(state: OverlayState) {
  const dpr = capture
    ? VIDEO_WIDTH / Math.max(1, overlayCanvas.clientWidth)
    : window.devicePixelRatio || 1;
  const w = Math.round(overlayCanvas.clientWidth * dpr);
  const h = Math.round(overlayCanvas.clientHeight * dpr);
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
  }
  overlay.clearRect(0, 0, w, h);
  drawOverlay(overlay, w, h, state);
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
  historyPanel.close();
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

/** The trained network's files, next to the page (public/models). */
const MODEL_URL = new URL('models/roteamento', document.baseURI).href;

function cyclePolicy() {
  const current = routing?.wanted ?? 'heuristic';
  const next = POLICY_CHOICES[(POLICY_CHOICES.indexOf(current) + 1) % POLICY_CHOICES.length];
  send({ type: 'policy', policy: next as PolicyChoice, model: MODEL_URL });
}

let agentErrorNoted = false;
function showRouting(r: RoutingStatus) {
  routing = r;
  const loading = r.wanted === 'rl' && r.agent === 'loading';
  document.getElementById('policy-label')!.textContent = loading
    ? 'carregando IA…'
    : POLICY_LABEL[r.shown];
  if (r.agent === 'error' && !agentErrorNoted) {
    agentErrorNoted = true;
    note(`Não foi possível carregar a IA de roteamento: ${r.agentError}`);
  }
  kpiPanel.updateRouting(r, POLICY_LABEL);
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

/** The help panel's list of shortcuts, drawn from the same table the keys are dispatched from. */
function renderHelp() {
  const list = document.getElementById('help-keys') as HTMLElement;
  list.replaceChildren();
  for (const s of SHORTCUTS) {
    const dt = document.createElement('dt');
    for (const part of s.label) {
      if (typeof part === 'string') {
        dt.append(part);
      } else {
        const kbd = document.createElement('kbd');
        kbd.textContent = part.kbd;
        dt.append(kbd);
      }
    }
    const dd = document.createElement('dd');
    dd.textContent = s.help;
    list.append(dt, dd);
  }
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
  document.getElementById('btn-policy')!.addEventListener('click', cyclePolicy);
  document.getElementById('btn-wear')!.addEventListener('click', () => send({ type: 'wear' }));
  document.getElementById('btn-heat')!.addEventListener('click', cycleHeat);
  document.getElementById('btn-quality')!.addEventListener('click', () => governor.cycle());
  document.getElementById('btn-help')!.addEventListener('click', () => toggleHelp());
  document.getElementById('btn-kpi')!.addEventListener('click', () => toggleKpi());
  document.getElementById('btn-lab')!.addEventListener('click', () => labPanel.toggle());
  document.getElementById('btn-demo')!.addEventListener('click', () => startDemo(false));
  document.getElementById('btn-record')!.addEventListener('click', () => startDemo(true));
  document.getElementById('btn-demo-exit')!.addEventListener('click', () => endDemo());
  // Panels above the control bar follow its real height (it wraps on narrow screens).
  const controls = document.querySelector('.hud--controls') as HTMLElement;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`);
  }).observe(controls);
  kpiPanel.onPick = openHistory;
  bindPicking();

  const failureKeys: Record<string, FailureKind> = {
    Digit5: 'conveyor',
    Digit6: 'surge',
    Digit7: 'robot',
    Digit8: 'dock',
  };
  const cameraKeys: Record<string, CameraPreset> = {
    Digit1: 'aerial',
    Digit2: 'ground',
    Digit3: 'follow',
  };
  renderHelp();
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const shortcut = shortcutFor(e.code, e.shiftKey);
    if (!shortcut) return;
    // Space/Enter on a focused button must keep activating that button.
    const onButton = e.target instanceof HTMLButtonElement;
    switch (shortcut.action) {
      case 'camera-preset':
        setCamera(cameraKeys[e.code] as CameraPreset);
        break;
      case 'next-robot':
        nextRobot();
        break;
      case 'failure':
        inject(failureKeys[e.code] as FailureKind);
        break;
      case 'auto-failures':
        toggleAuto();
        break;
      case 'wear':
        send({ type: 'wear' });
        break;
      case 'pause':
        if (onButton) return;
        e.preventDefault();
        // In the past, playing means continuing from there.
        if (timeline.viewing) continueHere();
        else setPaused(!paused);
        break;
      case 'seek':
        seekBy(e.code === 'BracketLeft' ? -10 : 10);
        break;
      case 'live':
        send({ type: 'live' });
        break;
      case 'continue':
        continueHere();
        break;
      case 'kpi':
        toggleKpi();
        break;
      case 'policy':
        cyclePolicy();
        break;
      case 'speed':
        changeSpeed(e.code === 'Comma' ? -1 : 1);
        break;
      case 'heat':
        cycleHeat();
        break;
      case 'stress':
        setStress(!stress);
        break;
      case 'quality':
        governor.cycle();
        break;
      case 'help':
        toggleHelp();
        break;
      case 'close':
        if (director.active) {
          endDemo();
          break;
        }
        toggleHelp(false);
        labPanel.toggle(false);
        if (historyPanel.entity) historyPanel.close();
        break;
      case 'restart':
        restart();
        break;
      case 'lab':
        labPanel.toggle();
        break;
      case 'demo':
        startDemo(false);
        break;
      case 'record':
        startDemo(true);
        break;
      case 'camera':
      case 'pick':
        break;
    }
  });

  window.addEventListener('resize', () => {
    const { w, h } = viewport();
    view.resize(w, h);
  });
  motionQuery.addEventListener('change', () => view.setReducedMotion(motionQuery.matches));
}

/** A click (not a drag) on the scene opens the history of what is under it. */
function bindPicking() {
  const ray = new Raycaster();
  const floor = new Plane(new Vector3(0, 1, 0), -0.4);
  const ndc = new Vector2();
  const hit = new Vector3();
  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 400) return;
    const box = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - box.left) / box.width) * 2 - 1,
      -((e.clientY - box.top) / box.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, view.orbit.camera);
    if (!ray.ray.intersectPlane(floor, hit)) return;
    const entity = pickEntity(layout, view.poses, hit.x, hit.z);
    if (entity) openHistory(entity);
  });
}

let last = performance.now();
let hudTimer = 0;
let historyTimer = 0;

function frame(now: number) {
  const realDt = Math.min((now - last) / 1000, 0.25);
  last = now;
  frameTimes.push(realDt * 1000);
  if (frameTimes.length > 3600) frameTimes.shift();
  const before = frames.renderTime;
  frames.advance(realDt);
  const simDt = Number.isNaN(before) ? 0 : Math.max(0, frames.renderTime - before);
  const sample = frames.sample();
  // The director moves the camera before the scene updates it.
  const demo = director.frame(realDt, frames.renderTime);
  if (sample) view.update(realDt, sample.frame, sample.alpha, simDt);
  view.render();
  governor.frame(realDt);
  if (demo) {
    drawDemoOverlay(demo);
    const c = capture;
    if (c) {
      // Recording starts with the demo's own run (not the frames of the run before it).
      const shown = frames.latest?.time ?? 0;
      if (!c.recording && director.phase === 'ai' && shown >= director.script.warmup - 0.5)
        c.start();
      if (c.recording) {
        c.context.drawImage(canvas, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
        drawOverlay(c.context, VIDEO_WIDTH, VIDEO_HEIGHT, demo);
        c.drawn++;
      }
      const card = director.beats.find((b) => b.id === 'resultado');
      if (c.recording && director.cardSeconds >= (card?.hold ?? 8)) void finishRecording();
    }
  }

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
  historyTimer -= realDt;
  if (historyPanel.entity && historyTimer <= 0) {
    historyTimer = 1;
    send({ type: 'history', entity: historyPanel.entity });
  }
  requestAnimationFrame(frame);
}

async function boot() {
  // Canvas-drawn labels need the web font loaded before they are rasterized.
  await Promise.all([
    document.fonts.load('700 64px "Barlow Condensed"'),
    document.fonts.load('500 16px "JetBrains Mono"'),
  ]).catch(() => undefined);
  // The app runs with the maintenance schedule of phase 4b (off by default in the engine).
  send({ type: 'init', config: { seed: DEFAULT_CONFIG.seed, scheduleMaintenance: true } });
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
    director,
    /** The last video recorded by the demo: format, bytes, frames drawn, frames in the file. */
    lastVideo: () => lastVideo,
    /**
     * Milliseconds per frame without and with the depth of field (the GPU work
     * included: one pixel is read back after each frame).
     */
    benchDof(n = 120) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const time = (on: boolean) => {
        view.setFocus(on ? view.orbit.distance : null);
        view.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t = performance.now();
        for (let i = 0; i < n; i++) {
          view.render();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        return (performance.now() - t) / n;
      };
      const off = time(false);
      const on = time(true);
      view.setFocus(null);
      return { offMs: off, onMs: on };
    },
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
