import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import { isTyping, type CameraPreset } from './render/camera';
import { QualityGovernor, type QualityLevel } from './render/quality';
import { SceneView } from './render/scene';
import { DEFAULT_CONFIG, World } from './sim/world';
import { Hud } from './ui/hud';

/** Order rate used by the load test: far above capacity, so piles grow past 2 000 packets. */
const STRESS_ARRIVAL_RATE = 40;
/** Never simulate more than this many steps in one frame (avoids a spiral after a stall). */
const MAX_STEPS_PER_FRAME = 240;

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

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const hud = new Hud();
const governor = new QualityGovernor('alta', (level) => applyQuality(level));

let world!: World;
let view!: SceneView;
let paused = false;
let stress = false;
let accumulator = 0;

function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

function applyQuality(level: QualityLevel) {
  const { w, h } = viewport();
  view.applyQuality(level, w, h);
}

/** Builds a fresh world and view with the same seed; the old view's GPU resources are released. */
function start() {
  view?.dispose();
  world = new World({ seed: DEFAULT_CONFIG.seed });
  if (stress) world.setArrivalRate(STRESS_ARRIVAL_RATE);
  view = new SceneView(renderer, world, canvas, motionQuery.matches);
  applyQuality(governor.level);
  accumulator = 0;
  setCamera('aerial');
}

function setCamera(preset: CameraPreset) {
  view.setCameraPreset(preset);
  document.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.camera === preset));
  });
}

function setPaused(v: boolean) {
  paused = v;
  const btn = document.getElementById('btn-pause') as HTMLButtonElement;
  btn.setAttribute('aria-pressed', String(v));
  btn.lastChild!.textContent = v ? ' Continuar' : ' Pausar';
}

function setStress(v: boolean) {
  stress = v;
  world.setArrivalRate(v ? STRESS_ARRIVAL_RATE : world.config.arrivalRate);
  document.getElementById('btn-stress')!.setAttribute('aria-pressed', String(v));
}

function toggleHelp(force?: boolean) {
  const help = document.getElementById('help') as HTMLElement;
  const open = force ?? help.hidden;
  help.hidden = !open;
  document.getElementById('btn-help')!.setAttribute('aria-expanded', String(open));
}

function bindControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach((b) => {
    b.addEventListener('click', () => setCamera(b.dataset.camera as CameraPreset));
  });
  document.getElementById('btn-pause')!.addEventListener('click', () => setPaused(!paused));
  document.getElementById('btn-stress')!.addEventListener('click', () => setStress(!stress));
  document.getElementById('btn-restart')!.addEventListener('click', start);
  document.getElementById('btn-quality')!.addEventListener('click', () => governor.cycle());
  document.getElementById('btn-help')!.addEventListener('click', () => toggleHelp());

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    // Space/Enter on a focused button must keep activating that button.
    const onButton = e.target instanceof HTMLButtonElement;
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
      case 'Space':
        if (onButton) return;
        e.preventDefault();
        setPaused(!paused);
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
        if (e.shiftKey) start();
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
  const frameDt = Math.min((now - last) / 1000, 0.25);
  last = now;
  const dt = world.config.dt;
  let simDt = 0;
  if (!paused) {
    accumulator += frameDt;
    let steps = Math.floor(accumulator / dt);
    if (steps > MAX_STEPS_PER_FRAME) {
      steps = MAX_STEPS_PER_FRAME;
      accumulator = 0;
    } else {
      accumulator -= steps * dt;
    }
    world.stepMany(steps);
    simDt = steps * dt;
  }
  view.update(frameDt, simDt, paused ? 1 : accumulator / dt);
  view.render();
  governor.frame(frameDt);

  hudTimer -= frameDt;
  if (hudTimer <= 0) {
    hudTimer = 0.2;
    hud.update(world, paused, {
      fps: governor.fps,
      quality: governor.level,
      autoQuality: governor.auto,
      drawn: view.packets.visible,
      hidden: view.packets.hidden,
      followedId: view.followedPacketId,
    });
  }
  requestAnimationFrame(frame);
}

async function boot() {
  // Canvas-drawn labels need the web font loaded before they are rasterized.
  await Promise.all([
    document.fonts.load('700 64px "Barlow Condensed"'),
    document.fonts.load('500 16px "JetBrains Mono"'),
  ]).catch(() => undefined);
  start();
  bindControls();
  // Render once, then reveal (shader compilation happens behind the loading screen).
  view.update(0, 0, 0);
  view.render();
  loading.classList.add('is-done');
  last = performance.now();
  requestAnimationFrame(frame);
}

// Read-only handle for automated checks (performance and memory scripts).
Object.defineProperty(window, '__gemeo', {
  value: {
    get world() {
      return world;
    },
    get view() {
      return view;
    },
    get governor() {
      return governor;
    },
    renderer: () => renderer,
  },
});

void boot();
