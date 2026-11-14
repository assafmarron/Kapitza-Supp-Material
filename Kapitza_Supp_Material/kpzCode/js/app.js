/**
 * app.js — Application Controller
 *
 * Wires together PhysicsEngine, Renderer, ChartManager, and all UI controls.
 * Drives the animation via requestAnimationFrame.
 *
 * Speed modes
 * ───────────
 * Normal (1×/2×/10×):
 *   stepsPerFrame = round(stepsPerSec × elapsedWallSecs × speedMultiplier)
 *   Physics tracks wall-clock time scaled by speedMultiplier.
 *   Charts rendered every 2nd frame to halve canvas work.
 *
 * Slow-mo (SLOW):
 *   Display rate: 4 fps (one render every 250 ms of wall time).
 *   Physics advance per frame: exactly T/4 = 1 / (4 × f_pivot).
 *   Shows the crank at each of the four wheel quadrants.
 *
 * Step (▷¼ button):
 *   Pauses the loop, advances exactly T/4, redraws once.
 *   Works regardless of the current speed setting.
 */

'use strict';

// ── Module instances ─────────────────────────────────────────────────────────

const engine   = new PhysicsEngine();

const simCanvas   = document.getElementById('sim-canvas');
const renderer    = new Renderer(simCanvas);

const angleCanvas    = document.getElementById('angle-chart');
const baseCanvas     = document.getElementById('base-chart');
const pivotCanvas    = document.getElementById('pivot-chart');
const velocityCanvas = document.getElementById('velocity-chart');
// sim-vs-ODEa (analytical) comparison charts, CLASSICAL mode only.
const odeAngleCanvas = document.getElementById('ode-angle-chart');
const odeAccelCanvas = document.getElementById('ode-accel-chart');

const charts = new ChartManager(angleCanvas, baseCanvas, pivotCanvas, velocityCanvas, odeAngleCanvas, odeAccelCanvas);

// ── Animation state ──────────────────────────────────────────────────────────

let isRunning       = false;
let rafHandle       = null;
let speedMultiplier = 1;
let lastFrameTime   = 0;
let frameCount      = 0;    // throttle chart redraws in normal mode

// Slow-mo state
let slowMoMode          = false;
let slowMoAccum         = 0;      // accumulated wall-clock ms awaiting next frame
const SLOW_MO_FPS      = 4;
const SLOW_MO_INTERVAL = 1000 / SLOW_MO_FPS;   // 250 ms between rendered frames

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Number of physics steps equal to one quarter of the pivot period (T/4).
 * This is the advance unit for both slow-mo frames and the step button.
 */
function quarterPeriodSteps() {
  const f = engine.params.frequency_pivot;
  // f = 0 means a static pivot (no period to quarter) — fall back to a
  // fixed small step count instead of dividing by zero.
  if (!f) return 25;
  return Math.max(1, Math.round(
    1 / (4 * f * engine.params.dt)
  ));
}

// ── Animation loop ───────────────────────────────────────────────────────────

function animate(timestamp) {
  if (!isRunning) return;

  const wallMs  = Math.min(timestamp - lastFrameTime, 50);  // ms, capped at 50
  lastFrameTime = timestamp;

  if (slowMoMode) {
    // Accumulate wall time; render only when a full slow-mo interval has elapsed.
    // Cap the accumulator to 2 intervals so a tab-blur can't cause burst catch-up.
    slowMoAccum = Math.min(slowMoAccum + wallMs, SLOW_MO_INTERVAL * 2);

    if (slowMoAccum >= SLOW_MO_INTERVAL) {
      slowMoAccum -= SLOW_MO_INTERVAL;
      engine.stepN(quarterPeriodSteps());
      renderer.render(engine, engine.params);
      charts.render(engine, engine.t);
      updateStatusBadge();
      if (engine.status === 'stopped' || engine.status === 'target_reached') { _onSettled(); return; }
    }
    // else: keep the rAF spinning but skip physics+render this frame

  } else {
    // Normal speed: advance enough physics to cover elapsed wall time × multiplier
    const stepsPerSec   = 1 / engine.params.dt;
    const stepsPerFrame = Math.max(1, Math.round(stepsPerSec * (wallMs / 1000) * speedMultiplier));
    engine.stepN(stepsPerFrame);

    renderer.render(engine, engine.params);

    frameCount++;
    if (frameCount % 2 === 0) charts.render(engine, engine.t);

    updateStatusBadge();
    // Both end states must stop the loop —
    // otherwise isRunning would stay true with a dead rAF loop after the run ends.
    if (engine.status === 'stopped' || engine.status === 'target_reached') { _onSettled(); return; }
  }

  rafHandle = requestAnimationFrame(animate);
}

/** Shared "pendulum has fully fallen" teardown. */
function _onSettled() {
  isRunning = false;
  updatePlayPauseBtn();
  renderer.render(engine, engine.params);
  charts.render(engine, engine.t);
  saveRunSummary();  // �
}

// ── Experiment capture ───────────────────────────────────────
// Auto-saves a readable per-run summary file (params + final results) the
// moment a run stops. Plain
// download: no picker, no permission dialog, works in every browser/origin —
// files land in the browser's default Downloads folder. (A folder-picker via the
// File System Access API was tried; it never surfaced a permission prompt even
// served from localhost (start-experiment-session.ps1), root cause unresolved.)

/** Filesystem-safe local-time timestamp, e.g. 2026-09-10_14-23-05 (matches tools/*.js convention). */
function timestampString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Plain-text, human-readable run summary: full param snapshot + final
 * results. No narrative field — purely objective. Every value is aligned to
 * a shared column across both sections.
 * @param {string} [statusOverride] Use this instead of engine.status/
 *   stopReason for the RESULTS status line — e.g. 'Manual Stop' when saving
 *   a run that was paused, not stopped/target_reached.
 */
function formatRunSummary(statusOverride) {
  const p = engine.params;
  const mode  = p.rigid_base ? 'CLASSICAL' : (p.earth_mode ? 'EARTH' : 'FREE'); //Ch38-Edt: was 'CLASSIC' — requested wording, matches "CLASSICAL mode" used everywhere else in the codebase/comments (this run-summary string was the one place still saying "CLASSIC")
  // Display-only precision (does not affect anything stored/calculated).
  // Per-field digit counts specified.
  const fixed = (n, digits) => n == null ? '' : n.toFixed(digits);

  const paramRows = [
    ['mode',                   mode],
    ['frequency_pivot_hz',     fixed(p.frequency_pivot, 3)],
    // Change54: amplitude/L_rod were 3 decimals (whole mm) — now 6;
    // stab_ speeds 3 -> 5 decimals; added f0 and deviation |f-f0|/f0.
    ['amplitude_pivot_m',      fixed(p.amplitude_pivot, 6)], //Ch54-Edt: was 3 decimals
    ['L_rod_m',                fixed(p.L_rod, 6)],           //Ch54-Edt: was 3 decimals
    // Change44: closed-form Kapitza stability prediction
    // (a*omega vs sqrt(2*g*L_rod), computed in physics.js _derive() — general L_rod, not
    // gated to L_rod=1 the way the sim-vs-ODEa trajectory comparison is) — logged so the
    // run's actual final status/angle can be checked against this formula's verdict.
    ['stab_drive_v_m_s',       fixed(p.stab_drive_v, 5)], //Ch54-Edt: was 3 decimals. //Ch44-Add: a*omega, the drive speed side of the formula
    ['stab_threshold_v_m_s',   fixed(p.stab_threshold_v, 5)], //Ch54-Edt: was 3 decimals. //Ch44-Add: sqrt(2*g*L_rod), the threshold side of the formula
    ['stab_threshold_freq_hz', fixed(p.stab_threshold_f, 4)], //Ch54-Add: predicted threshold frequency f0
    ['deviation_pct',          fixed(p.stab_deviation * 100, 3)], //Ch54-Add: |f-f0|/f0 in percent
    ['stability_predicted',    p.stab_predicted_stable ? 'STABLE' : 'FALL'], //Ch44-Add: the verdict
    // Change46: V_Hat_Sim (real crank-slider kinematics) vs
    // ODEa_V_Hat_SineRef (idealized-sine closed form), see physics.js _computeVHatSim() —
    // logged so a significant mismatch (short arm ratio, or a bug) is visible in the file,
    // not just inferred from the run having stopped up front (see stopReason below).
    ['v_hat_sim_m2_s2',        fixed(p.V_Hat_Sim, 5)], //Ch46-Add: real crank kinematics, mean-square pivot velocity over one cycle
    ['v_hat_sine_ref_m2_s2',   fixed(p.ODEa_V_Hat_SineRef, 5)], //Ch46-Add: idealized-sine closed-form reference
    ['mass_bob_kg',            fixed(p.mass_bob, 7)],     //Ch55-Edt: was 3 decimals (whole g)
    ['mass_base_kg',           fixed(p.mass_base_kg, 7)], //Ch55-Edt: was 3 decimals
    ['angle_rod_initial_deg',  fixed(p.angle_rod_initial * 180 / Math.PI, 2)],
    ['stop_angle_deg',         p.stop_angle_deg != null ? fixed(p.stop_angle_deg, 2) : 'off'],
    ['time_limit_s',           p.time_limit_s   != null ? fixed(p.time_limit_s, 1)   : 'off'],
    ['stop_on_ode_mismatch',   p.stop_on_ode_mismatch ? 'on' : 'off'], //Ch53-Add: Change53 switch (value at save time)
    // the EFFECTIVE steps per amplitude actually used (may exceed the slider value at low frequency)
    ['steps_per_amplitude',    String(p.steps_per_cycle / 4)], // effective steps per amplitude (quarter cycle) after low-frequency override and rounding
    ['steps_per_half_cycle',   String(p.steps_per_half_cycle)],
    ['history_window_s',       String(p.history_window_s)],
  ];
  if (p.earth_mode && !p.rigid_base) paramRows.push(['k_spring_n_per_m', String(p.k_spring)]);

  const resultRows = [
    ['status',                 statusOverride || engine.status],
    ['t_stop_s',               fixed(engine.t, 2)],
    ['final_angle_deg',        fixed(engine.angle_rod * 180 / Math.PI, 2)],
    ['stopReason',             statusOverride || engine.stopReason || ''],
    ['swing_max_deg',          fixed(engine.swing_max_deg, 2)],
    ['swing_min_deg',          fixed(engine.swing_min_deg, 2)],
    ['swing_max_rate_deg_s',   fixed(engine.swing_max_rate, 4)],
    ['swing_min_rate_deg_s',   fixed(engine.swing_min_rate, 4)],
    ['swing_angle_total_deg',  fixed(engine.swing_angle_total_deg, 2)],
    ['swing_total_log_rate',   fixed(engine.swing_total_log_rate, 3)],
    ['angle_max_deg',          fixed(engine.angle_max_deg, 2)],
    ['angle_min_deg',          fixed(engine.angle_min_deg, 2)],
    // Change51a: the Change50 base readings (legend yBase / vB1s / aB1s) at the moment
    // the run stopped, same units and digits as the legend. Empty = not yet defined (vB1s needs t ≥ 1 s, aB1s t ≥ 2 s).
    ['y_base_mm',              p.rigid_base ? 'rigid' : fixed(engine.y_base * 1000, 2)], //Ch51a-Add
    ['v_base_1s_mm_s',         p.rigid_base ? 'rigid' : fixed(engine.v_base_1s == null ? null : engine.v_base_1s * 1000, 2)], //Ch51a-Add: sliding 1 s average speed
    ['a_base_1s_m_s2',         p.rigid_base ? 'rigid' : fixed(engine.a_base_1s, 3)], //Ch51a-Add: sliding 1 s average acceleration; g felt by the pendulum ≈ 9.8 + this
    // Change53b: first sim-vs-ODEa mismatch, recorded even when "ODE stop" is off.
    ['ode_mismatch_first',     !engine._odeaCompareActive() ? 'not checked (CLASSICAL mode, 1 m rod only)'  //Ch53b-Add
                               : (engine.odeMismatchFirst == null ? 'none'
                               : `t=${engine.odeMismatchFirst.t.toFixed(3)} s (${engine.odeMismatchFirst.kind})`)],
  ];

  // Align every value to one shared column across both sections ("a bit
  // distant from the label ... doesn't have to be perfect").
  const allKeys    = [...paramRows, ...resultRows].map(([k]) => k);
  const labelWidth = Math.max(...allKeys.map(k => k.length)) + 4; // key + ':' + gap
  const row = ([k, v]) => `  ${(k + ':').padEnd(labelWidth)}${v}`;

  const lines = [
    'Kapitza Pendulum — Run Summary',
    `Saved: ${new Date().toString()}`,
    '',
    'PARAMETERS',
    ...paramRows.map(row),
    '',
    'RESULTS',
    ...resultRows.map(row),
  ];
  return lines.join('\n') + '\n';
}

function saveRunSummary(statusOverride) {
  try {
    const blob = new Blob([formatRunSummary(statusOverride)], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `kpz-run_${timestampString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[Kapitza] Failed to save run summary:', e);
  }
}

// ── Playback controls ─────────────────────────────────────────────────────────

function startLoop() {
  if (isRunning) return;
  isRunning     = true;
  lastFrameTime = performance.now();
  slowMoAccum   = 0;    // start each run cleanly — no leftover partial interval
  rafHandle     = requestAnimationFrame(animate);
  updatePlayPauseBtn();
}

function pauseLoop() {
  isRunning = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  updatePlayPauseBtn();
}

// Change43: factored the "was this a paused, in-progress run"
// check out of resetSim() into its own function — a run that was manually paused (not
// already stopped/target_reached — those are saved by _onSettled the moment they first
// stop, so re-saving here would duplicate) and has real progress was previously only
// saved when the user clicked Reset. But changing any parameter slider, or switching
// EARTH/FREE/CLASSICAL mode, ALSO discards the paused run (both call engine.setParams(),
// which calls engine.reset() internally) — and neither of those call sites had this
// check, so a paused run's data was silently lost with no record at all if the user's
// next action was "change a parameter" rather than "click Reset" .
// Must be called BEFORE whatever resets engine state — checking after would always see
// the already-reset state instead of the paused run that's about to be discarded.
/**
 * If the sim is currently paused mid-run (not stopped/target_reached, has real progress),
 * save it as 'Manual Stop'. Returns whether it did, though no caller currently needs that.
 */
function saveIfPausedMidRun() {
  const wasPaused = !isRunning && engine.status === 'running' && engine.t > 0; //Ch43-Add: same condition resetSim() used inline before this refactor
  if (wasPaused) saveRunSummary('Manual Stop'); //Ch43-Add: same save call resetSim() used inline before this refactor
  return wasPaused; //Ch43-Add: exposed in case a future caller wants to know
}

function resetSim() {
  saveIfPausedMidRun(); //Ch43-Edt: was the inline wasPaused/saveRunSummary check, now shared — see saveIfPausedMidRun() above

  pauseLoop();
  engine.reset();
  renderer.trail = [];
  slowMoAccum    = 0;
  renderer.render(engine, engine.params);
  charts.render(engine, engine.t);
  updateStatusBadge();
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function updatePlayPauseBtn() {
  const btn = document.getElementById('btn-play');
  btn.textContent    = isRunning ? '⏸' : '▶';
  btn.setAttribute('aria-label', isRunning ? 'Pause simulation' : 'Play simulation');
  btn.classList.toggle('active', isRunning);
}

function updateStatusBadge() {
  const badge    = document.getElementById('status-badge');
  const angle    = Math.abs(engine.angle_rod);
  const status   = engine.status;
  const stable   = angle < 0.25;   // < ~14° considered stable

  // 'target_reached' covers reaching the default
  // 90 deg stop_angle_deg (and the time limit), so it reads as the "it fell" case by default.
  // 'stopped' covers the numerical stops (base oscillation under-resolved, sim-vs-analytical
  // angle/acceleration mismatch), so its label is a generic 'Stopped'; the full engine.stopReason
  // goes in the title attribute (hover tooltip) on every branch, so the detail is one hover away
  // instead of console-only.
  badge.title = engine.stopReason || '';
  if (status === 'stopped') {
    badge.textContent = 'Stopped';
    badge.className   = 'status-badge fell';
  } else if (status === 'target_reached') {
    const deg = (angle * 180 / Math.PI).toFixed(1);
    badge.textContent = `${deg}° at t=${engine.t.toFixed(3)}s`;
    badge.className   = 'status-badge unstable';
  } else if (stable) {
    badge.textContent = 'STABLE';
    badge.className   = 'status-badge stable';
  } else {
    badge.textContent = 'UNSTABLE';
    badge.className   = 'status-badge unstable';
  }
}

// ── Button event listeners ────────────────────────────────────────────────────

document.getElementById('btn-play').addEventListener('click', () => {
  // If the run has stopped (numerical stop or stop-angle/time target), reset before playing // "base limit" no longer exists
  if (engine.status === 'stopped' || engine.status === 'target_reached') resetSim();
  isRunning ? pauseLoop() : startLoop();
});

document.getElementById('btn-reset').addEventListener('click', resetSim);

// ── Reset parameters to defaults ─────────────────────────────────────────────

/**
 * Raw slider values that correspond to DEFAULT_PARAMS.
 * Must stay in sync with the `value` attributes in index.html
 * and the toPhysics transforms in the bindSlider calls below.
 */
const SLIDER_DEFAULTS = {
  'slider-freq':       20,        // Hz (linear)
  'slider-amplitude':  0.01,      // m (linear)
  'slider-rodlength':  0,         // log₁₀ of L_rod = 1 m (
                                   // consolidated; matches physics.js DEFAULT_PARAMS.L_rod)
  'slider-rigidity':   1.7,       // log₁₀ of mass_base_kg (~50 kg)
  'slider-spring':     3,         // log₁₀ of k_spring (N/m)
  'slider-angle':      1,         // degrees (converted to rad inside toPhysics)
  'slider-stopangle':  90,        // degrees; 0 = off (converted to null inside toPhysics).
                                   // matches
                                   // physics.js DEFAULT_PARAMS.stop_angle_deg.
  'slider-timelimit':  20,        // seconds; 0 = off (converted to null inside toPhysics).
  'slider-history':    25,        // seconds; 0 = no history recorded
  'slider-stepsperamplitude': 25,  // integration steps per pivot amplitude = quarter cycle (linear); matches physics.js DEFAULT_PARAMS.steps_per_amplitude
  'slider-mass':       1.7,       // log₁₀ of mass_base_kg (~50 kg)
  // 
  'slider-massbob':    -1.30103,  // log₁₀ of mass_bob (0.05 kg = 50 g)
  // 
};

// ── Environment mode (EARTH / FREE / CLASSICAL) ──────────────────────────────

/**
 * Switch between Earth, Free-float, and Classical (rigid-base) modes.
 * Updates the toggle buttons, shows/hides the relevant parameter rows,
 * and applies the change to the physics engine.
 */
function setEnvMode(mode) {
  const isFree      = mode === 'free';
  const isClassical = mode === 'classical';
  const isEarth     = mode === 'earth';

  // Change53a: only the three mode buttons (they carry data-env). Was '.env-btn', which
  // also cleared the highlight of the other toggles sharing that style (Forces, Charts mode, ODE stop).
  document.querySelectorAll('.env-btn[data-env]').forEach(b => { //Ch53a-Edt: was '.env-btn'
    b.classList.toggle('active', b.dataset.env === mode);
  });

  document.getElementById('earth-only-params').style.display      = isEarth     ? '' : 'none';
  document.getElementById('free-only-params').style.display       = isFree      ? '' : 'none';
  document.getElementById('classical-only-params').style.display  = isClassical ? '' : 'none';

  // CLASSICAL is physically EARTH-like (ground, no float) but with the base
  // pinned at rest — earth_mode stays true, rigid_base takes over.
  saveIfPausedMidRun(); //Ch43-Add: save a paused-with-progress run before setParams()'s internal reset() discards it 
  engine.setParams({ earth_mode: !isFree, rigid_base: isClassical });
  charts.setMode(isFree);
  renderer.trail = [];
  renderer.render(engine, engine.params);
  charts.render(engine, engine.t);
  updateStatusBadge();
  if (isRunning) pauseLoop();
}

document.querySelectorAll('.env-btn[data-env]').forEach(btn => {
  btn.addEventListener('click', () => setEnvMode(btn.dataset.env));
});

function resetParams() {
  // Reset environment to EARTH first
  setEnvMode('earth');

  // Restore each slider to its default raw value and fire the input
  // event so the display label and physics engine both update.
  Object.entries(SLIDER_DEFAULTS).forEach(([id, defaultRaw]) => {
    const slider = document.getElementById(id);
    if (slider) {
      slider.value = defaultRaw;
      slider.dispatchEvent(new Event('input'));
    }
  });
}

document.getElementById('btn-reset-params').addEventListener('click', resetParams);

// ── Speed buttons ─────────────────────────────────────────────────────────────

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (btn.dataset.speed === 'slow') {
      slowMoMode  = true;
      slowMoAccum = 0;
    } else {
      slowMoMode      = false;
      speedMultiplier = parseFloat(btn.dataset.speed);
    }
  });
});

// ── Step button (▷¼) ──────────────────────────────────────────────────────────

/**
 * Advance exactly one quarter pivot period and redraw.
 * Pauses the animation loop first so the step is crisp.
 */
function stepQuarter() {
  if (engine.status === 'stopped' || engine.status === 'target_reached') return;
  pauseLoop();
  engine.stepN(quarterPeriodSteps());
  renderer.render(engine, engine.params);
  charts.render(engine, engine.t);
  updateStatusBadge();
}

document.getElementById('btn-step').addEventListener('click', stepQuarter);

// ── Chart scrolling mode toggle ───────────────────────────────────────────────

document.getElementById('btn-chart-scroll').addEventListener('click', () => {
  const scrolling = !charts.angleChart.opts.scrolling;
  charts.setScrolling(scrolling);
  const btn = document.getElementById('btn-chart-scroll');
  btn.classList.toggle('active', scrolling);
  btn.textContent = scrolling ? 'Charts: scroll' : 'Charts: fixed';
  if (!isRunning) charts.render(engine, engine.t);
});

// ── Chart visibility toggles ──────────────────────────────────────────────────

function refreshChartBorders() {
  const canvases = [...document.querySelectorAll('.chart-area canvas')];
  let firstVisible = canvases.find(c => c.style.display !== 'none');
  canvases.forEach(c => {
    // Reset inline border only on the first visible canvas to prevent an
    // orphan left-border when a preceding canvas is hidden.
    c.style.borderLeft = (c === firstVisible) ? 'none' : '';
    c.style.borderTop  = (c === firstVisible) ? 'none' : '';
  });
}

document.querySelectorAll('.chart-vis-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const canvas  = document.getElementById(btn.dataset.chart);
    const hiding  = canvas.style.display !== 'none';
    canvas.style.display = hiding ? 'none' : '';
    btn.classList.toggle('active', !hiding);
    refreshChartBorders();
    if (!isRunning) charts.render(engine, engine.t);
  });
});

// ── Force-vector overlay toggle ───────────────────────────────────────────────

document.getElementById('btn-forces').addEventListener('click', () => {
  renderer.showForces = !renderer.showForces;
  const btn = document.getElementById('btn-forces');
  btn.classList.toggle('active', renderer.showForces);
  btn.textContent = renderer.showForces ? 'Forces: on' : 'Forces: off';
  if (!isRunning) renderer.render(engine, engine.params);
});

// ── Stop-on-ODE-mismatch switch ───────────────────────────────────────────────
// Change53. Sets the param directly instead of via setParams(), which would reset the
// run — so it can be flipped mid-run. A run already stopped by a mismatch stays stopped.
document.getElementById('btn-ode-stop').addEventListener('click', () => { //Ch53-Add
  engine.params.stop_on_ode_mismatch = !engine.params.stop_on_ode_mismatch; //Ch53-Add
  const btn = document.getElementById('btn-ode-stop');                      //Ch53-Add
  btn.classList.toggle('active', engine.params.stop_on_ode_mismatch);       //Ch53-Add
  btn.textContent = engine.params.stop_on_ode_mismatch ? 'ODE stop: on' : 'ODE stop: off'; //Ch53-Add
});

// ── Parameter sliders ─────────────────────────────────────────────────────────

/**
 * Bind a range input to a physics parameter.
 * @param {string}   sliderId   id of the <input type="range">
 * @param {string}   paramKey   key in engine.params to update
 * @param {Function} toPhysics  maps slider raw value → physical value
 * @param {Function} toDisplay  maps (rawValue, physValue) → display string
 */
function bindSlider(sliderId, paramKey, toPhysics, toDisplay) {
  const slider  = document.getElementById(sliderId);
  const display = document.getElementById(sliderId + '-val');

  // Render the initial display value
  const initRaw = parseFloat(slider.value);
  display.textContent = toDisplay(initRaw, toPhysics(initRaw));

  slider.addEventListener('input', () => {
    const raw  = parseFloat(slider.value);
    const phys = toPhysics(raw);
    display.textContent = toDisplay(raw, phys);

    // Apply parameter change (resets simulation)
    saveIfPausedMidRun(); //Ch43-Add: save a paused-with-progress run before setParams()'s internal reset() discards it 
    engine.setParams({ [paramKey]: phys });
    renderer.trail = [];

    // Refresh both canvases with the new initial state
    renderer.render(engine, engine.params);
    charts.render(engine, engine.t);
    updateStatusBadge();
    if (isRunning) pauseLoop();
  });
}

// Pivot frequency: 0–200 Hz (linear) — range set in index.html (Change52: max was 100 Hz)
bindSlider(
  'slider-freq',
  'frequency_pivot',
  v => v,
  (raw) => raw.toFixed(3) + ' Hz' // Changed - increased frequencey precision to 0.001
);

// Pivot amplitude: 1–30 mm (linear)
// Change54: label showed whole mm while the slider moves in 0.1 mm
// steps, so "12 mm" could be 11.5–12.4 mm. Now 2 decimals of mm (one extra, to be safe).
bindSlider(
  'slider-amplitude',
  'amplitude_pivot',
  v => v,
  (raw) => (raw * 1000).toFixed(2) + ' mm' //Ch54-Edt: was Math.round(raw * 1000) + ' mm'
);

// Rod length: log₁₀ scale, 1–100 cm (0.01–1 m)
bindSlider(
  'slider-rodlength',
  'L_rod',
  v => Math.pow(10, v),
  (raw) => (Math.pow(10, raw) * 100).toFixed(3) + ' cm' //Ch54-Edt: was toFixed(1); continuous log slider, now shown to 0.01 mm
);

// Change55: mass/spring labels rounded by size (whole g, 0.1 kg,
// whole kg, whole N/m), hiding the exact log-slider value (e.g. 10^1.7 = 50.1187 kg shown
// as "50 kg"). Now 6 significant digits everywhere so a reader can redo calculations.
const exactMass = (kg) => kg < 1 ? (kg * 1000).toPrecision(6) + ' g' : kg.toPrecision(6) + ' kg'; //Ch55-Add

// Bob mass: log₁₀ scale, 1 g – 1 kg 
bindSlider(
  'slider-massbob',
  'mass_bob',
  v => Math.pow(10, v),
  (raw) => exactMass(Math.pow(10, raw)) //Ch55-Edt: was whole g / 2 decimals of kg
);
// 

// Base mass (earth mode): log₁₀ scale −1.3–1.7 → 50 g–50 kg
bindSlider(
  'slider-rigidity',
  'mass_base_kg',
  v => Math.pow(10, v),
  (raw) => {
    const str = exactMass(Math.pow(10, raw)); //Ch55-Edt: was whole g / 0.1 kg / whole kg by size
    if (raw >= 1.2)  return str + '  (rigid)';
    if (raw <= -0.8) return str + '  (soft)';
    return str;
  }
);

// Spring constant: log₁₀ scale 1–4  →  k = 10–10 000 N/m
bindSlider(
  'slider-spring',
  'k_spring',
  v => Math.pow(10, v),
  (raw) => Math.pow(10, raw).toPrecision(6) + ' N/m' //Ch55-Edt: was Math.round (e.g. 10^3.1 = 1258.93 shown as 1259)
);

// Initial angle: 0°–89° (linear degrees, convert to radians); default is 1°
// (value="1" in index.html), matching DEFAULT_PARAMS.angle_rod_initial in
// physics.js.
bindSlider(
  'slider-angle',
  'angle_rod_initial',
  v => v * Math.PI / 180,
  (raw) => raw.toFixed(1) + '°'
);

// Stop at angle: 0–90° (linear degrees); 0 = off
bindSlider(
  'slider-stopangle',
  'stop_angle_deg',
  v => v > 0 ? v : null,
  (raw) => raw > 0 ? raw.toFixed(1) + '°' : 'off'
);

// Run time limit: 0–600 s (linear); 0 = off.
bindSlider(
  'slider-timelimit',
  'time_limit_s',
  v => v > 0 ? v : null,
  (raw) => raw > 0 ? raw.toFixed(1) + ' s' : 'off'
);

// History window: 0–60 s (linear); 0 = no history recorded
bindSlider(
  'slider-history',
  'history_window_s',
  v => v,
  (raw) => raw > 0 ? raw.toFixed(0) + ' s' : 'off'
);

// Sim resolution: 1–2500 steps per pivot amplitude = quarter oscillator cycle (linear)
bindSlider(
  'slider-stepsperamplitude', // id of the renamed slider element in index.html
  'steps_per_amplitude', // engine param this slider drives (physics.js derives steps per cycle/half cycle from it)
  v => Math.round(v), // slider value -> whole number of steps
  (raw) => Math.round(raw).toString() // label text: whole number of steps
);

// Base mass (FREE mode): log₁₀ scale −2–1.7  →  10 g–50 kg
bindSlider(
  'slider-mass',
  'mass_base_kg',
  v => Math.pow(10, v),
  (raw) => exactMass(Math.pow(10, raw)) //Ch55-Edt: was whole g / 0.1 kg / whole kg by size
);

// ADDED THE BELOW 
// ── Initial sync: drive the engine from the sliders' actual HTML values ──────
// Without this, `engine` starts from physics.js's DEFAULT_PARAMS (line 28:
// `new PhysicsEngine()` with no overrides) — which can silently diverge from
// what each slider's value= attribute shows on load. bindSlider()'s own init
// code only paints the label text, it never calls engine.setParams() until
// the user actually drags the slider. This closes that gap for every slider
// at once, and works even if index.html and indexV2.html have different
// slider defaults, since each file drives itself from its own DOM.
document.querySelectorAll('.param-row input[type="range"]').forEach(slider => {
  // Skip sliders belonging to a mode that isn't active on load (EARTH is
  // the default per the HTML) — otherwise slider-mass (FREE mode's base-mass
  // slider) would fire after slider-rigidity (EARTH mode's) since it's later
  // in the DOM, silently overwriting mass_base_kg with the wrong slider's value.
  if (slider.closest('#free-only-params, #classical-only-params')) return;
  slider.dispatchEvent(new Event('input'));
});


// ── Canvas resize handling ────────────────────────────────────────────────────

/** Sync sim canvas intrinsic size to its CSS layout size (keeps it sharp). */
function resizeSimCanvas() {
  const rect = simCanvas.getBoundingClientRect();
  if (simCanvas.width  !== Math.round(rect.width) ||
      simCanvas.height !== Math.round(rect.height)) {
    simCanvas.width  = Math.round(rect.width);
    simCanvas.height = Math.round(rect.height);
  }
}

/** Sync all chart canvases to their CSS layout sizes. */
function resizeChartCanvases() {
  [angleCanvas, baseCanvas, pivotCanvas, velocityCanvas, odeAngleCanvas, odeAccelCanvas].forEach(canvas => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  });
}

window.addEventListener('resize', () => {
  resizeSimCanvas();
  resizeChartCanvases();
  if (!isRunning) {
    renderer.render(engine, engine.params);
    charts.render(engine, engine.t);
  }
});

// ── Chart-splitter drag ───────────────────────────────────────────────────────

const chartSplitter = document.getElementById('chart-splitter');
const chartArea     = document.getElementById('chart-area');

let isDraggingSplitter  = false;
let splitterDragStartY  = 0;
let splitterDragStartH  = 0;

chartSplitter.addEventListener('mousedown', e => {
  isDraggingSplitter = true;
  splitterDragStartY = e.clientY;
  splitterDragStartH = chartArea.getBoundingClientRect().height;
  chartSplitter.classList.add('dragging');
  document.body.style.cursor     = 'ns-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!isDraggingSplitter) return;
  // Positive delta → user dragged upward → chart area grows
  const delta = splitterDragStartY - e.clientY;
  const panelH = document.querySelector('.canvas-panel').getBoundingClientRect().height;
  const newH   = Math.max(80, Math.min(splitterDragStartH + delta, panelH * 0.72));
  chartArea.style.height = newH + 'px';
  resizeChartCanvases();
  if (!isRunning) charts.render(engine, engine.t);
});

document.addEventListener('mouseup', () => {
  if (!isDraggingSplitter) return;
  isDraggingSplitter = false;
  chartSplitter.classList.remove('dragging');
  document.body.style.cursor     = '';
  document.body.style.userSelect = '';
  resizeChartCanvases();
  if (!isRunning) charts.render(engine, engine.t);
});

// ── Display mode (sim / both / charts) ───────────────────────────────────────

const canvasPanel = document.getElementById('canvas-panel');

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;

    // Update button highlight
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Apply the mode — CSS rules take over visibility
    canvasPanel.dataset.mode = mode;

    // Wait one frame for the browser to reflow, then resize canvases and repaint
    requestAnimationFrame(() => {
      resizeSimCanvas();
      resizeChartCanvases();
      renderer.render(engine, engine.params);
      charts.render(engine, engine.t);
    });
  });
});

// ── Initial paint ─────────────────────────────────────────────────────────────

resizeSimCanvas();
resizeChartCanvases();
renderer.render(engine, engine.params);
charts.render(engine, engine.t);
updateStatusBadge();
updatePlayPauseBtn();

// ── Theme toggle ──────────────────────────────────────────────────────────────

const btnTheme = document.getElementById('btn-theme');

// Heroicons solid (20×20 viewBox).
// Sun  → shown in dark mode  (click to go light).
// Moon → shown in light mode (click to go dark) — drawn as two arcs so it
//         is unmistakably a crescent, not a banana.
const ICON_SUN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">'
  + '<path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"/>'
  + '</svg>';

const ICON_MOON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">'
  + '<path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>'
  + '</svg>';

/**
 * Apply a theme ('light' or 'dark'), update the button icon, persist to
 * localStorage, and redraw both canvases so colours take effect immediately.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  btnTheme.innerHTML = theme === 'light' ? ICON_MOON : ICON_SUN;
  const label = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  btnTheme.title = label;
  btnTheme.setAttribute('aria-label', label);
  try { localStorage.setItem('kapitza-theme', theme); } catch (e) {}
  renderer.render(engine, engine.params);
  charts.render(engine, engine.t);
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Always initialise so the icon is correct even when no saved preference exists.
try {
  const saved = localStorage.getItem('kapitza-theme');
  applyTheme(saved === 'light' ? 'light' : 'dark');
} catch (e) {
  applyTheme('dark');
}
