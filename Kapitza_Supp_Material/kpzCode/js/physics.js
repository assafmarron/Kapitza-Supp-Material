/**
 * physics.js — Kapitza Pendulum Simulation Engine
 *
 * Physical system:
 *   An oscillator wheel (crank-and-slider) drives a pivot up and down.
 *   A pendulum rod+bob hangs (inverted) from the pivot.
 *   The whole device rests on a spring-supported base.
 *   
 *   1. At the beginning, at t=0, only initial values are set.
 *   2. Steps are counted k=1,2,3,...
 *   3. At the end of step k, the time is dt*k.
 *   4. After step k, at time dt*k, the values refer to different times:
 *      some for "now", some for half a step or a full step behind.
 *   For each step computation:
 *   5. Compute pivot position at (end of) step k, from the crank geometry. We add the base position in Earth and Free modes
 *      (it is zero in CLASSICAL mode).
 *   6. Compute pivot velocity associated with step k from position at step k and at (end of) step k-1.
 *      This value is ALSO an estimate of the instantaneous pivot velocity  at time t=(dt*k-(dt/2)).
 *   7. Compute acceleration that is associated with step k from average velocity at step k and average velocity at step k-1.
 *      This value is ALSO an estimate of the instantaneous acceleration at time dt*(k-1).
 *   8. With the above pivot acceleration, gravity on bob, and bob's estimated tangential speed,
 *      compute the rod's contribution to the bob's acceleration. It acts along the rod and has three parts:
 *      the pivot's along-rod share, the cancellation of gravity's along-rod share, and the centripetal part
 *      that keeps the bob on its circle.
 *   9. From these, get the bob's horizontal and vertical acceleration: gravity plus the rod's contribution
 *      (which includes the centripetal part).
 *  10. Compute the force of the rod on the base from the rod's contribution and the rod angle at the START of step k
 *      (the angle left by step k-1), so both refer to time dt*(k-1). It is applied to the base in the same step,
 *      solved together with the base acceleration (Change47, OCT-31-2026; it used to be applied one step later).
 *  11. Predict the bob's new position from the bob's acceleration (Stormer-Verlet / leapfrog). Termed "temp".
 *  12. Compute the rod angle of the predicted (temp) bob position relative to the new pivot position.
 *      The snap in the next item keeps this angle and only fixes the distance.
 *  13. Snap the predicted position to the nearest point of the circle of radius L_rod around the new pivot location.
 *  14. New bob velocity (associated with step k) = realized displacement / dt
 * Units: SI — meters, kg, seconds, radians
 * Sign conventions:
 *   y-axis points UP.
 *   angle_rod is measured clockwise from the upward vertical.
 *   Positive y_base = spring stretched upward (rare); negative = compressed.
 */

'use strict';

// ── Stability criterion (for reference) ───────────────────────────────────────
// The Kapitza effect requires:   a · ω  >  √(2 · g · L_rod)
//   where a = amplitude_pivot (pivot half-strole = quarter of full path = wheel radius),  
//         ω = 2π · frequency_pivot.
//
// With the defaults below (a=0.01m, f=20Hz, L=1m; L_rod defaults to 1m so the
// sim-vs-analytical (ODE) comparison below runs out of the box; see
// ODEa_L_ROD_TOLERANCE):
//   a·ω  =  0.01 × 125.7  =  1.26 m/s
//   √(2gL)  =  √(2×9.8×1) =  4.43 m/s     → below threshold at 20 Hz.
// Stability threshold at a=0.01m: f > 70.5 Hz.
// To be stable at 20 Hz the amplitude must exceed 0.0352 m.
//
// amplitude_pivot and L_rod are both independently user-adjustable (see the
// "Pivot amplitude" and "Rod length" sliders) — this formula's √(2gL) and a·ω
// terms move independently as those are dragged, which is the point: it lets
// the live simulation be compared against this idealized-formula prediction.

const DEFAULT_PARAMS = {
  g:                        9.8,   // gravitational acceleration (m/s²). Constant 
  frequency_pivot:          20,    // Hz.  0hz to 100hz 
  amplitude_pivot:          0.01,  // m — pivot half-stroke = pivot quarter cycle = wheel radius. 0.001–0.03 m.
  ratio_arm_to_amplitude:   100,   // L_arm = 100 × amplitude_pivot — keeps the crank-slider geometry safe at any amplitude
  L_rod:                    1,     // m — pendulum rod length, independent of amplitude_pivot. UI-adjustable: 0.01–1 m.
                                    // Default is exactly 1m so the
                                    // sim-vs-analytical (ODE) comparison (gated on L_rod=1, see
                                    // ODEa_L_ROD_TOLERANCE) runs out of the box; Artstein eq (5.1) is stated
                                    // for a unit-length rod.
  mass_bob:                 0.05,  // bob mass (kg) originally was arbitrary and fixed. but it affects forces. adding slider 
  k_spring:                 1000,  // spring constant (N/m)
  angle_rod_initial:        0.01745,   // initial rod angle from vertical (rad, ~1°)
  stop_angle_deg:           90,    // degrees; stop as soon as |angle_rod| reaches it; 0/null = disabled.
  time_limit_s:             20,    // seconds; stop as soon as elapsed sim time reaches it; 0/null = disabled.
  stop_on_ode_mismatch:     true,  // Change53: false = the three sim-vs-ODEa checks in _recordChange22Sample() no longer stop the run (GUI switch "ODE stop") //Ch53-Add
  history_window_s:         25,    // seconds of history kept for the charts; 0 = no history recorded at all
  // steps_per_half_cycle and steps_per_cycle are DERIVED in
  // _derive() from steps_per_amplitude below. One "amplitude" = a quarter of the pivot cycle
  // (pivot half-stroke = wheel radius), so steps_per_cycle = 4 × steps_per_amplitude.
  steps_per_amplitude:      25,    // integration steps per pivot amplitude (quarter cycle); sets dt resolution
  earth_mode:               true,  // when false: no spring/ground, base floats freely
  mass_base_kg:             50,    // base mass (kg)
  rigid_base:               false, // CLASSICAL mode: base is exactly immovable —
                                    // y_base/v_base pinned to 0 every step.  This is
                                    // the true infinite-base-mass limit (the textbook
                                    // Kapitza pendulum), not an approximation via a
                                    // very stiff spring — a stiff spring never reaches
                                    // exactly zero motion and forces a tiny dt.
                                    // these concepts are equated "Classical" and :"rigid base"
  analytic_compare:         true,  // manual on/off flag for the sim-vs-analytical (ODE) comparison.
                                    // Also requires CLASSICAL mode (rigid_base) and L_rod=1m (see
                                    // ODEa_L_ROD_TOLERANCE) to actually run — always defaults to true, no
                                    // auto-detection logic.
};

// Change27: the low-frequency rule is a FIXED SpA
const LOW_FREQ_HZ              = 10; // pivot frequency (Hz) at or below which the slow gravity-driven fall needs finer time resolution
const LOW_FREQ_STEPS_PER_AMP   = 50; // Ch27-Edt: steps per amplitude (SpA) used at/below LOW_FREQ_HZ — fixed, the slider value is ignored there (precision in slow gravity-based fall)

// Change35a: guards for the frequency_pivot=0 ("static pivot, time
// the free fall") case, which Change35's unclamped dt formula would otherwise break.
const FREQ_PIVOT_EPSILON_HZ    = 0.0001; // Hz — stand-in used ONLY for period_pivot/omega_osc when
                                          // frequency_pivot=0, so period_pivot stays finite (1/0 would be
                                          // Infinity); p.frequency_pivot itself is left at 0 for display/log
                                          // and for the other guards below that key off it directly
const DT_MAX_LOW_FREQ_S        = 0.01;   // s — dt ceiling applied only at/below LOW_FREQ_HZ, where dt would
                                          // otherwise scale with 1/frequency_pivot and become absurdly coarse
                                          // (e.g. ~50s/step at 0.0001 Hz) — this is NOT a reinstatement of
                                          // Change35's removed floor clamp, which was the actual bug there;
                                          // this is a ceiling, and only in the regime where phase-exactness
                                          // (what Change35 fixed) is moot because there is no real pivot cycle

const SWING_RATE_WINDOW = 10; // # confirmed extrema kept per side/total for smoothed-rate calc
const BASE_CRASH_STEPS_PER_CYCLE = 12; // min live-measured steps/full-cycle of v_base's own oscillation
                                        // before declaring dt too coarse to trust; 3 steps/quarter-cycle
const BASE_CRASH_CONSECUTIVE     = 3;  // Ch48-Add: # of short half-cycles IN A ROW needed to stop (see step() section 3c)
const ANGLE_HISTORY_WINDOW_S = 120; // seconds of rod-angle-only history kept in a dedicated
                                     // typed-array ring buffer, independent of history_window_s
                                     // / the general `history` array.

// Change46: V_Hat_Sim (real crank-slider kinematics) vs
// ODEa_V_Hat_SineRef (idealized-sine closed form) were computed but never compared —
// see conversation. A slider-crank's velocity profile deviates from pure sine by
// O((r_osc/L_arm)^2); at the default ratio_arm_to_amplitude=100 that's ~0.0001 (0.01%),
// so these thresholds are sized to flag a REAL mismatch (short arm ratio, or a bug),
// not that expected tiny baseline deviation.
const V_HAT_MISMATCH_REL   = 0.05;  // relative threshold — not a principled/derived value
const V_HAT_MISMATCH_FLOOR = 1e-4;  // (m/s)^2 — absolute floor so the relative threshold
                                     // doesn't collapse to ~0 at very small amplitude/frequency

// ── sim-vs-analytical (ODE) comparison, CLASSICAL mode only ──────
// Change47: renamed the single "ODE_" prefix (used since Change22)
// to "ODEa_", and reserved "ODEx_" for a second, DIFFERENT analytical reference planned for a
// later stage (b) — see conversation (the MyPhysicsLab MoveablePendulumSim comparison). Both
// are analytical (not from the actual simulated rod/crank), which is what "ODE" (bare, no
// suffix — used in comments/section headers below as the umbrella term for the whole feature)
// still means; "a"/"x" distinguish WHICH equation:
//
//   ODEa ("averaged")  — Kapitza/Levi/Artstein's AVERAGED (mean-field) equation, eq 5.1 in
//                         Artstein 2021: theta'' = (g - V_hat*cos(theta))*sin(theta). This is
//                         the SLOW-envelope limit as driving frequency -> infinity (theorem is
//                         an asymptotic result, not exact at any finite frequency) — it has NO
//                         fast-timescale content at all, by construction. Needs L_rod=1 (see
//                         ODEa_L_ROD_TOLERANCE — Artstein's eq is stated for a unit-length rod).
//                         Everything in this section today (all ODEa_* below) is this variant.
//
//   ODEx ("exact")     — NOT YET BUILT (stage b). The EXACT, non-averaged equation Kapitza/Levi
//                         both actually START from, before applying averaging: theta'' =
//                         -(g + a_pivot(t))/L * sin(theta), using the REAL instantaneous pivot
//                         acceleration (not a cycle-averaged V_hat), integrated independently
//                         (e.g. simple Euler, same style as ODEa_angle/ODEa_angVel below) every
//                         step, at full (not stroboscopic) time resolution — same recording
//                         cadence as the sim's own raw angle_rod, since the whole point is
//                         validating the sim's tractrix integrator against the fast-timescale
//                         physics too, not just the slow envelope. General L_rod (no L=1 gate).
//                         Tests a DIFFERENT thing than ODEa: "is my own numerical integrator
//                         faithful to the true equations of motion" (a numerical-method
//                         question), vs. ODEa's "does the averaging theory itself hold at this
//                         frequency" (a physics-approximation question) — orthogonal checks,
//                         either could pass while the other fails.
//
// Naming rule going forward: "ODE" bare stays only in prose/section-header comments as the
// umbrella term for "this whole analytical-comparison feature, both variants." Every actual
// identifier (constant, field, method) always carries the "a" or "x" suffix — never bare.
//
// "ODEa_" prefix marks anything analytical — derived from the idealized
// equation of motion in the Kapitza/Levi/Artstein papers — as opposed to
// everything else here (smoothed or raw), which comes from the actual
// simulated rod/crank. Specific paper/equation references to follow.
const ODEa_VHAT_CYCLE_SAMPLES     = 20000; // fixed resolution for the one-time
  // V_Hat_Sim integration, independent of dt/steps_per_half_cycle.
const ODEa_L_ROD_TOLERANCE        = 1e-6;  // L_rod must equal 1m (within this
  // tolerance) for the comparison to run — Artstein eq (5.1) is stated for
  // a unit-length rod; this sidesteps needing the L_rod/L_rod^2 restoration
  // derived earlier in conversation for the general case.
const ODEa_ANGLE_DIVERGENCE_REL   = 0.15;  // relative threshold, global
  // (cumulative) check: stop if |angle_rod - ODEa_angle| exceeds this
  // fraction of |ODEa_angle| plus the floor below. Tune once real numbers
  // are visible — not a principled/derived value.
const ODEa_ANGLE_DIVERGENCE_FLOOR = 0.01;  // rad (~0.57°) — absolute floor so
  // the relative threshold doesn't collapse to ~0 near ODEa_angle=0.
const ODEa_ACCEL_DIVERGENCE_REL   = 0.15;  // relative threshold, local
  // (instantaneous) check — same shape as above, applied to angular
  // acceleration instead of angle. Also not a principled/derived value.
const ODEa_ACCEL_DIVERGENCE_FLOOR = 0.05;  // rad/s^2 — absolute floor.

// Change37: the TIGHT check above only has 2-3 stroboscopic
// samples (one full pivot period apart) to finite-difference from early on, which is coarse
// enough to false-positive on a genuinely-diverging (below-stability-threshold) trajectory —
// see conversation, the 10 Hz run that stopped at t=0.6s with a diff just barely (~2%) over
// the limit, before the more robust WIDE check (10 samples apart) had enough data to weigh in.
// Below this time, a tight-check mismatch is computed but neither stops the sim nor logs
// ("look for it in the graphs") — the WIDE check and the global/cumulative angle check
// (1) above are NOT gated by this and remain active from t=0.
const ODEa_ACCEL_TIGHT_GRACE_S = 3; // s — not a principled/derived value (A guess at
  // enough settling time); revisit if legitimate runs still trip the tight check past this.

// Wide/"doubly smoothed" acceleration check: a second, independent estimate of angular
// acceleration, using a much wider baseline (ODEa_ACCEL_WIDE_N strobe
// snapshots apart) instead of the tight check's single-cycle spacing —
// computed by the IDENTICAL two-step finite-difference procedure on BOTH
// the sim's angle (angleRodSmoothHist -> angVelWideHist -> angAccWideHist)
// and the ODEa shadow trajectory (ODEa_angleHist -> ODEa_angVelWideHist ->
// ODEa_accelWideHist), so the comparison is like-for-like: two numbers built
// the same way from each side, not "a smoothed sim number vs. an exact
// algebraic ODEa number" (see conversation for why that earlier form was
// apples-to-oranges). ODEa_accelWideHist vs. ODEa_accelHist (the exact
// algebraic evaluation) is itself a useful sanity check on the
// finite-difference method's own error, independent of any sim-vs-theory
// question.
const ODEa_ACCEL_WIDE_N               = 10;   // strobe snapshots spanned —
  // tunable; not a principled/derived value.
const ODEa_ACCEL_WIDE_DIVERGENCE_REL  = 0.15; // same shape as the tight
  // check's thresholds, kept as an independent constant so it can be tuned
  // separately once real numbers are visible.
const ODEa_ACCEL_WIDE_DIVERGENCE_FLOOR = 0.05; // rad/s^2

class PhysicsEngine {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this._derive();
    this.reset();
  }

  // ── Derived quantities ──────────────────────────────────────────────────

  /**
   * Recompute all quantities that follow from the user-adjustable params.
   * Must be called whenever params change.
   */
  _derive() {
    const p = this.params;

    p.r_osc  = p.amplitude_pivot;
    p.L_arm  = p.ratio_arm_to_amplitude * p.amplitude_pivot;   // connecting-arm length
    // p.L_rod is set directly (independent parameter) — nothing to derive here.

    p.mass_base   = p.mass_base_kg;
    p.m_on_spring = p.mass_base + p.mass_bob;

    // Oscillator angular velocity (rad/s)
    const freqEff  = p.frequency_pivot > 0 ? p.frequency_pivot : FREQ_PIVOT_EPSILON_HZ; //Ch35a-Add: effective frequency used only below — 0 -> epsilon, else unchanged
    p.omega_osc    = 2 * Math.PI * freqEff;  //Ch35a-Edt: use freqEff (was p.frequency_pivot) so this stays finite at f=0
    p.period_pivot = 1 / freqEff;            //Ch35a-Edt: use freqEff (was p.frequency_pivot) — 1/0 would be Infinity

    // Change44: closed-form Kapitza stability prediction (CLAUDE.md's
    // "Stability criterion" / Artstein's linearized eq 5.1-5.2 threshold — see conversation, the
    // 70.3/70.47/70.6 Hz bracketing) — a·ω >= sqrt(2*g*L_rod). Deliberately uses the RAW
    // frequency_pivot (not freqEff above) so f=0 correctly gives drive_v=0 -> predicted unstable,
    // matching the literal formula rather than the f=0-epsilon workaround Change35a needed
    // elsewhere. General L_rod (NOT gated to L_rod=1 the way the sim-vs-ODEa trajectory comparison
    // is, see _odeaCompareActive()) — this prediction is meant to be checked against the actual
    // run outcome at ANY rod length, independent of whether the ODEa comparison feature is active.
    p.stab_drive_v      = p.amplitude_pivot * 2 * Math.PI * p.frequency_pivot; //Ch44-Add: a*omega, the vibration's driving speed (m/s), using the actual selected frequency (0 if the slider is at 0)
    p.stab_threshold_v  = Math.sqrt(2 * p.g * p.L_rod);                       //Ch44-Add: sqrt(2*g*L_rod), the minimum driving speed the closed-form formula requires for stability
    p.stab_predicted_stable = p.stab_drive_v >= p.stab_threshold_v;           //Ch44-Add: the verdict itself — true iff the closed-form formula predicts the near-upright position is stable
    // Change54: predicted threshold frequency f0 (where a*omega = sqrt(2gL)),
    // from the exact (unrounded) amplitude and rod length, and the run's deviation |f-f0|/f0.
    p.stab_threshold_f  = p.stab_threshold_v / (2 * Math.PI * p.amplitude_pivot); //Ch54-Add: f0 (Hz); amplitude slider min is 0.1 mm, so never /0
    p.stab_deviation    = Math.abs(p.frequency_pivot - p.stab_threshold_f) / p.stab_threshold_f; //Ch54-Add: |f-f0|/f0 (fraction; displayed as %)

    // steps_per_half_cycle and steps_per_cycle
    // (steps per FULL pivot cycle = the stroboscopic sampling interval for the sim-vs-analytical
    // comparison) are derived from steps_per_amplitude (one amplitude = quarter pivot cycle). At/below
    // LOW_FREQ_HZ the steps per amplitude (SpA) is FIXED at LOW_FREQ_STEPS_PER_AMP and the slider value
    // is ignored, to allow precision in the slow gravity-based fall (Change27).
    // The one-time V_Hat_Sim computation follows (see _computeVHatSim()).
    let stepsPerAmp = p.steps_per_amplitude; // start from the user/default steps per amplitude (slider)
    if (p.frequency_pivot <= LOW_FREQ_HZ) { // slow pivot -> slow gravity-driven fall needs finer steps
      stepsPerAmp = LOW_FREQ_STEPS_PER_AMP; // Ch27-Edt: at/below LOW_FREQ_HZ use the fixed SpA of 50, ignoring the slider
    }
    stepsPerAmp = Math.max(1, Math.round(stepsPerAmp)); // whole number of steps, at least 1 — ensures divisibility by 4 below
    p.steps_per_cycle      = 4 * stepsPerAmp; // 4 amplitudes per full pivot cycle — always divisible by 4 (needed for exact quarter-cycle stepping)
    p.steps_per_half_cycle = 2 * stepsPerAmp; // 2 amplitudes per half pivot cycle — always even/divisible by 2
    this._computeVHatSim();

    // dt depends on the pivot period only.
    // Will handle spring-frequency-based dt sizing separately later.
    // Change35: removed the [1e-5, 0.01] clamp — it was silently
    // stretching dt past what steps_per_cycle assumed (e.g. 100 Hz/steps_per_amplitude=300
    // hit the 1e-5 floor), which broke phase_steps_exact below and corrupted the sim-vs-ODEa
    // stroboscopic comparison. dt is now exactly period_pivot/steps_per_cycle, so
    // dt*steps_per_cycle == period_pivot holds by construction for any frequency_pivot > 0.
    p.dt = p.period_pivot / p.steps_per_cycle;  //Ch35-Edt: time step = full pivot period / steps per cycle, no clamping (was: clamped half-cycle formula)
    // Change35a: at/below LOW_FREQ_HZ, period_pivot is now finite
    // (via freqEff above) but can still be huge (e.g. ~10000s at the f=0 stand-in), which would
    // make dt absurdly coarse for the free-fall test this branch exists for. Cap dt there only —
    // phase-exactness (what Change35 restored) is moot in this branch since there's no real pivot
    // cycle to be exact about; normal oscillating frequencies are untouched by this if.
    if (p.frequency_pivot <= LOW_FREQ_HZ) { //Ch35a-Add: same threshold already used for the fine-step override above
      p.dt = Math.min(p.dt, DT_MAX_LOW_FREQ_S); //Ch35a-Add: ceiling dt so the free-fall integration stays fine enough to resolve the fall
    }

    // The integer pivot-phase counter kept in step() lines up with the crank
    // angle only when dt was NOT clamped above, i.e. exactly steps_per_cycle steps fit in one pivot period.
    p.phase_steps_exact = p.frequency_pivot > 0 && Math.abs(p.dt * p.steps_per_cycle - p.period_pivot) <= 1e-9 * p.period_pivot; // true only if dt*steps_per_cycle == pivot period (so phase steps match crank angle); false for f=0 or a clamped dt — the phase sanity checks are skipped then

    // Ring-buffer capacity for the dedicated rod-angle history — sized to
    // the CURRENT dt so it always covers exactly ANGLE_HISTORY_WINDOW_S
    // seconds regardless of steps_per_half_cycle/frequency, same pattern as
    // maxHistory below.
    p.maxAngleHistory = Math.ceil(ANGLE_HISTORY_WINDOW_S / p.dt);

    // Change50: steps in one second for the base's sliding 1 s average speed / acceleration
    // (legend rows vB1s / aB1s). dt need not divide 1 s exactly, so the window is round(1/dt) steps = ~1 s and
    // step() divides by that exact window length.
    p.baseHistStepsPerSec = Math.max(1, Math.round(1 / p.dt)); //Ch50-Add

  }

  // ── sim-vs-analytical (ODE) comparison, CLASSICAL mode only ──

  /**
   * One-time computation of V_Hat_Sim: the mean-square pivot velocity over
   * one full crank-wheel cycle, from the REAL simulated pivot Track
   * kinematics — used only as an input to the ODEa (analytical) formula in
   * _recordChange22Sample(). Base pinned at y_base=0, matching the
   * immovable-base assumption Artstein's/Kapitza's/Levi's theory requires.
   * Uses a fixed ODEa_VHAT_CYCLE_SAMPLES resolution, independent of the
   * sim's own dt/steps_per_half_cycle, and re-runs automatically on every
   * _derive() call (i.e. whenever frequency_pivot/amplitude_pivot/
   * ratio_arm_to_amplitude change).
   * Also computes p.ODEa_V_Hat_SineRef: the reference V-hat an IDEAL sine
   * profile of the same amplitude/frequency would give — closed form,
   * comparison value only, not used in the ODEa formula itself.
   */
  _computeVHatSim() {
    const p = this.params;
    const N = ODEa_VHAT_CYCLE_SAMPLES;
    const dtCycle = p.period_pivot / N;

    let sumSq = 0;
    let yPrev = null;
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * 2 * Math.PI;
      const y  = this._pivotRelYAtTheta(theta); // Ch31-Edt: y_pivot_rel at crank angle theta, base fixed at 0 (the crank geometry lives in _pivotRelYAtTheta)
      if (yPrev !== null) {
        const v = (y - yPrev) / dtCycle;
        sumSq += v * v;
      }
      yPrev = y;
    }
    p.V_Hat_Sim = sumSq / N;

    p.ODEa_V_Hat_SineRef = 0.5 * (p.omega_osc * p.amplitude_pivot) ** 2;

    // Change46: compare the two — previously computed but never
    // checked against each other (see conversation). A significant mismatch here means the
    // crank-slider's velocity profile has departed meaningfully from pure sine (short arm
    // ratio) or something is wrong — either way, worth catching before a run proceeds on a
    // V_Hat_Sim value that doesn't mean what it's assumed to mean.
    const vHatDiff  = Math.abs(p.V_Hat_Sim - p.ODEa_V_Hat_SineRef); //Ch46-Add: absolute gap between the real-kinematics and idealized-sine values
    const vHatLimit = V_HAT_MISMATCH_REL * Math.abs(p.ODEa_V_Hat_SineRef) + V_HAT_MISMATCH_FLOOR; //Ch46-Add: relative-plus-floor limit, same shape as the existing ODEa divergence checks
    p.vHatMismatchSignificant = vHatDiff > vHatLimit; //Ch46-Add: true iff the mismatch exceeds the limit — read by reset() to stop the run up front
    p.vHatMismatchReason = p.vHatMismatchSignificant //Ch46-Add: human-readable reason, built now while the numbers are at hand, used verbatim as stopReason
      ? `V_Hat_Sim (${p.V_Hat_Sim.toFixed(5)} (m/s)^2) vs ODEa_V_Hat_SineRef (${p.ODEa_V_Hat_SineRef.toFixed(5)} (m/s)^2) `
        + `differ by ${vHatDiff.toFixed(5)}, exceeding limit ${vHatLimit.toFixed(5)} — the crank-slider's actual `
        + `velocity profile has departed significantly from pure sine (check ratio_arm_to_amplitude).`
      : '';
  }

  /**
   * Whether the sim-vs-analytical (ODE) comparison should run this step:
   * the manual flag, CLASSICAL mode (rigid_base), and L_rod pinned to
   * exactly 1m (within tolerance). Artstein eq (5.1) is stated for a
   * unit-length rod; running only at L_rod=1 sidesteps needing the general
   * L_rod/L_rod^2 restoration derived earlier in conversation. Deliberately
   * NOT run outside CLASSICAL mode at all — see the straw-man discussion:
   * outside CLASSICAL mode the ODEa formula isn't a fair comparison against
   * the sim's own (base-coupled) trajectory.
   */
  _odeaCompareActive() {
    const p = this.params;
    return p.analytic_compare && p.rigid_base && Math.abs(p.L_rod - 1) < ODEa_L_ROD_TOLERANCE;
  }

  // ── State initialization ────────────────────────────────────────────────

  /** Reset all dynamic state to t = 0. */
  reset() {
    const p = this.params;

    // Oscillator wheel angle (clockwise from the upward y-axis)
    this.theta_osc = 0;

    // Pivot phase checks, pivot kinematics and bob-acceleration outputs. They are computed each step in step()
    // section 3b; the bob update (section 4) and the force on the base use them.
    // Change28: there is no separate phase counter any more. The phase of a time j*dt is
    // j % steps_per_cycle (phase 0 = crank pointing up = top of stroke), derived from the step number k (this._stepCount).
    this._phaseCheckFailures = 0; // how many pivot-phase sanity checks (peak / stroke-centre) have failed so far — diagnostics only
    this.v_pivot_c           = 0; // pivot vertical velocity, central difference (m/s), incl. base velocity
    this.a_pivot             = 0; // pivot vertical acceleration (m/s^2, up positive), central second difference, incl. base acceleration
    this.a_pivot_along_rod   = 0; // component of pivot acceleration along the rod (positive = pivot->bob direction)
    this.a_pivot_perp_rod    = 0; // component of pivot acceleration perpendicular to the rod (positive = clockwise tangent)
    this.a_pivot_rod_x       = 0; // horizontal part of the along-rod pivot-acceleration component (m/s^2)
    this.a_pivot_rod_y       = 0; // vertical part of the along-rod pivot-acceleration component (m/s^2)
    this.a_rod_on_bob        = 0; // acceleration (m/s^2) the rod alone gives the bob along pivot -> bob; positive = rod pushing the bob outward
    this.a_bob_x_calc        = 0; // bob horizontal acceleration in the inertial frame from the constraint dynamics (m/s^2); used by the bob update in section 4
    this.a_bob_y_calc        = 0; // bob vertical acceleration in the inertial frame from the constraint dynamics (m/s^2); used by the bob update in section 4
    this.constraint_correction = 0; // size (m) of the rod-length correction applied in the last bob update (diagnostic; ~0 when the acceleration is consistent with the rod)

    // Pivot y-position relative to wheel center c1 (= base level) at the initial crank angle:
    // at theta=0 the crank arm points straight up, so the pivot is at its top (L_arm + r_osc).
    // Derived via the triangle: arm length, horizontal offset, connecting arm (see _pivotRelYAtTheta).
    // Change31
    this.y_pivot_rel = this._pivotRelYAtTheta(this.theta_osc); // Ch31-Edt: initial pivot height above the base from the crank angle

    // Base / spring state  (wheel center c1 is at y = y_base)
    this.y_base = 0;
    this.v_base = 0;

    // Absolute pivot position and velocity
    this.y_pivot = this.y_pivot_rel + this.y_base;
    this.v_pivot = 0; // Note that even if wheel is rotating - when carm is at top, v_pivot is 0 - no need for special handling for startup.

    // Pendulum: bob starts near upright
    // x_pivot is always 0 (pivot is constrained to the vertical axis)
    this.angle_rod = p.angle_rod_initial;
    this.x_bob     = p.L_rod * Math.sin(this.angle_rod);
    this.y_bob     = this.y_pivot + p.L_rod * Math.cos(this.angle_rod);

    // Bob velocity (zero at start)
    this.v_bob_x = 0;
    this.v_bob_y = 0;

    // Constraint force from rod on base (y-direction, Newton's 3rd law).
    // Computed in section 3b of each step;
    // applied in the next step's base dynamics.
    // Initialized to zero — correct for t=0 (no motion yet).
    this.F_rod_on_base  = 0;
    this.F_rod_on_pivot_x = 0; // horizontal rod force on the pivot (N), absorbed by the track; diagnostic only
    this.F_rod_on_pivot_y = 0; // vertical rod force on the pivot (N); equals F_rod_on_base

    // Force the rod exerts on the bob (both axes) and spring force on base.
    // Used only for the force-vector overlay in the renderer.
    this.F_rod_on_bob_x = 0;
    this.F_rod_on_bob_y = 0;
    this.F_spring_y     = 0;

    // Simulation time (s)
    this.t = 0;

    // Base-oscillation "crash" check: live-measures steps per
    // full v_base oscillation cycle via its own zero-crossings (not a static
    // estimate from the spring's natural frequency — catches genuine
    // resonance/nonlinear breakdown a static estimate could miss) and stops
    // if dt is too coarse to resolve it.
    // (see step() section 3c)
    this._stepCount     = 0; // Ch28-Edt: k = number of the step being (or last) executed; 0 = no step yet. Incremented once, at the top of step()
    this._baseCrossSign = null; // sign of v_base as of the last processed step
    this._baseCrossStep = 0;    // step count at the last confirmed zero-crossing; 0 = no crossing yet (Ch48: the first crossing is only recorded, not measured)
    this._baseShortCount = 0;   // Ch48-Add: # of consecutive short half-cycles of v_base seen so far

    // Swing extremum tracking: tracks the running max (while
    // angle_rod > 0) or min (while < 0) and finalizes it as a confirmed swing
    // on a debounced zero-crossing (period_pivot/2). See
    // project_swing_range_metric_design.md.
    // The debounce is on the zero-crossing,
    // not on a direction reversal (extremum): an extremum debounce proved vulnerable to ripple —
    // confirmed "extrema" fired almost every period_pivot/2, tracking pivot-frequency ripple (whose
    // amplitude scales with the swing itself) rather than the true ~0.376s-scale envelope, verified
    // empirically. Zero-crossing debounce doesn't have this problem: near a crossing the true signal is
    // moving fastest (mid-swing), so it clears the crossing before ripple can fake a second one; near a
    // turning point the true signal is nearly stationary, which is exactly what let ripple fake
    // reversals there. Known, accepted limitation: a swing confined to one side of zero (e.g. 1°-3°
    // without crossing) isn't detected as separate turning points.
    const angleDegInit = this.angle_rod * 180 / Math.PI;
    this.swing_max_deg         = angleDegInit;
    this.swing_min_deg         = angleDegInit;
    this.swing_max_rate        = null;         // deg/s, smoothed slope over last SWING_RATE_WINDOW confirmed maxima
    this.swing_min_rate        = null;         // deg/s, smoothed slope over last SWING_RATE_WINDOW confirmed minima
    this.swing_angle_total_deg = 0;            // swing_max_deg - swing_min_deg
    this.swing_total_log_rate  = null;         // 1/s, log derivative of swing_angle_total_deg

    this._swingSign         = angleDegInit >= 0 ? 1 : -1; // which side of zero angle_rod is currently on
    this._swingRunPeak      = angleDegInit;    // running max (sign>0) / min (sign<0) since last confirmed crossing
    this._swingPendingSign  = null;            // opposite sign currently being debounced, or null
    this._swingPendingSince = 0;               // sim time the pending sign was first observed
    this._swingMaxBuf   = [];      // [{deg, t}, ...] last confirmed maxima, oldest first
    this._swingMinBuf   = [];      // [{deg, t}, ...] last confirmed minima, oldest first
    this._swingTotalBuf = [];      // [{deg, t}, ...] last confirmed total-span values, oldest first

    // Simple running max/min of angle_rod since t=0, unconditional — NOT
    // swing/crossing-based like swing_max_deg/swing_min_deg above; this is
    // just "what's the most extreme angle this run has ever reached, on
    // either side, ever" (a fall pushes these too, unlike the swing-based
    // pair).
    this.angle_max_deg = angleDegInit;
    this.angle_min_deg = angleDegInit;

    // Simulation status: 'running' | 'target_reached' | 'stopped'
    this.status     = 'running';
    this.stopReason = '';

    // Change46: stop up front (before any step runs) if the
    // crank-slider's real velocity profile significantly departs from the idealized-sine
    // assumption V_Hat_Sim is meant to approximate — see _computeVHatSim(). Checked here,
    // right after status is initialized to 'running' above, so it overrides that default
    // before step() ever gets a chance to run (step() returns immediately once status is
    // 'stopped' — see its guard at the top).
    if (p.vHatMismatchSignificant) { //Ch46-Add: flag computed once in _computeVHatSim(), re-derived on every _derive() call
      this.status     = 'stopped';           //Ch46-Add: overrides the 'running' just set above
      this.stopReason = p.vHatMismatchReason; //Ch46-Add: human-readable reason built in _computeVHatSim()
      console.warn('[Kapitza] Stop:', this.stopReason); //Ch46-Add: same console pattern as the other stop checks in this file
    }

    // Time-series history: [{t, angle_deg, y_base_mm}, ...]
    // Sized to cover history_window_s (plus margin over the charts' own
    // window) at the current dt, regardless of how small dt gets — a fixed
    // step count like 10000 could cover as little as ~1 s at the smallest dt
    // and silently truncate the charts' time axis.
    // history_window_s <= 0 disables history recording entirely (maxHistory
    // = 0): no O(n) Array.shift() per step, and the charts just render
    // empty — useful for fast/long headless-style runs that don't need
    // live charts.
    this.history    = [];
    this.maxHistory = p.history_window_s > 0 ? Math.ceil(p.history_window_s / p.dt) : 0;

    // Dedicated rod-angle-only ring buffer (ANGLE_HISTORY_WINDOW_S=120s),
    // independent of history_window_s and the array above — always on,
    // sized from the current dt (p.maxAngleHistory, see _derive()). Plain
    // typed arrays + a wrapping write index, not push()/shift() on a plain
    // array: at fine dt this can be millions of entries, and avoiding
    // per-element object overhead is what keeps that affordable (~16
    // bytes/entry vs. real object overhead for millions of {t,deg} objects).
    this.angleHistT     = new Float64Array(p.maxAngleHistory);
    this.angleHistDeg   = new Float64Array(p.maxAngleHistory);
    this.angleHistCount = 0; // valid entries written so far, caps at length
    this.angleHistPos   = 0; // next write index (wraps)

    // Change50: y_base over the last 2 s (sliding), for the legend's 1 s average
    // base speed v_base_1s = (y(t) − y(t−1)) / 1 s and acceleration a_base_1s = (y(t) − 2·y(t−1) + y(t−2)) / (1 s)².
    // Positions, not the instantaneous v_base, so the pivot-frequency shake of the base averages out.
    this.baseHistY     = new Float64Array(2 * p.baseHistStepsPerSec + 1); //Ch50-Add: 2 s of y_base plus the sample at the window start
    this.baseHistY[0]  = this.y_base; //Ch50-Add: the t = 0 sample
    this.baseHistCount = 1;           //Ch50-Add: valid entries written so far, caps at length
    this.baseHistPos   = 1;           //Ch50-Add: next write index (wraps)
    this.v_base_1s     = null;        //Ch50-Add: m/s, null until 1 s of history exists
    this.a_base_1s     = null;        //Ch50-Add: m/s², null until 2 s of history exist

    // Change53b: first sim-vs-ODEa mismatch of the run, {t, kind}, recorded whether or not
    // the "ODE stop" switch stops the run (see _noteOdeMismatch()). Shown in the legend and the results file.
    this.odeMismatchFirst = null; //Ch53b-Add

    // sim-vs-analytical (ODE) comparison, CLASSICAL mode only —
    // see _recordChange22Sample(). ODEa_angle/ODEa_angVel are integrated
    // independently every step in step() (never resynced from angle_rod —
    // this is what keeps the comparison non-strawman, see conversation);
    // the *Hist arrays below are separate, self-contained {t,value}
    // histories — never sharing storage/indices between sim-side and
    // ODEa-side values.
    this.ODEa_angle  = p.angle_rod_initial;
    this.ODEa_angVel = 0;

    this.angleRodSmoothHist = []; // [{t,value}] sim's stroboscopic angle_rod
    this.angVelSmoothHist   = []; // [{t,value}] sim's smoothed angular velocity
    this.angAccSmoothHist   = []; // [{t,value}] sim's smoothed angular acceleration (tight, 1-cycle baseline)
    this.angVelWideHist     = []; // [{t,value}] sim's WIDE angular velocity —
                                   // from angleRodSmoothHist samples ODEa_ACCEL_WIDE_N-1 apart
    this.angAccWideHist     = []; // [{t,value}] sim's "doubly wide" angular acceleration —
                                   // from TWO angVelWideHist entries ODEa_ACCEL_WIDE_N-1 apart
                                   // (symmetric with ODEa_accelWideHist below, so the
                                   // two are a fair apples-to-apples comparison — NOT compared
                                   // against ODEa_accelHist, which uses a different, exact method)
    this.ODEa_angleHist      = []; // [{t,value}] independent ODEa angle trajectory
    this.ODEa_angVelWideHist = []; // [{t,value}] ODEa's WIDE angular velocity — same
                                   // construction as angVelWideHist, applied to ODEa_angleHist
    this.ODEa_accelWideHist  = []; // [{t,value}] ODEa's "doubly wide" angular acceleration —
                                   // from TWO ODEa_angVelWideHist entries, mirroring
                                   // angAccWideHist exactly (apples-to-apples check)
    this.ODEa_accelHist      = []; // [{t,value}] ODEa formula evaluated EXACTLY (algebraic, not
                                   // finite-differenced) at the sim's own current smoothed angle

    if (this._odeaCompareActive()) this._recordChange22Sample(); // t=0 sample
  }

  // ── Parameter updates ───────────────────────────────────────────────────

  /**
   * Apply new parameter values, re-derive, and reset.
   * @param {Partial<typeof DEFAULT_PARAMS>} newParams
   */
  setParams(newParams) {
    Object.assign(this.params, newParams);
    this._derive();
    this.reset();
  }

  // ── Simulation step ─────────────────────────────────────────────────────

  /** Advance by exactly one timestep dt. */
  step() {
    // 'running'        : normal simulation
    // 'target_reached' : |angle_rod| crossed stop_angle_deg (or time_limit_s elapsed) — stop here
    // 'stopped'         : a numerical check fired (base oscillation under-resolved, or
    //                     sim-vs-analytical mismatch) — stop here
    if (this.status === 'stopped' || this.status === 'target_reached') return;

    const p  = this.params;
    const dt = p.dt;

    // Change28: the step number is counted once, here at the top, so it is k for the WHOLE step.
    this._stepCount++; // Ch28-Edt: count this step here, once per step, before anything else uses the step number
    const k = this._stepCount; // Ch28-Add: k = number of the step being executed (k = 1, 2, 3, ...); step k runs from (k-1)*dt to k*dt

    // ── HOW VALUES ARE ORGANISED IN STEP k — Change32 and Change33 ──
    // Step k (k = 1, 2, 3, ...) runs from time dt*(k-1) to time dt*k. There is no *_old copy of anything: the start-of-step
    // value of a state field is simply this.X, because the fields are committed only at the end of the step.
    //   "start"      = the start of step k, t = dt*(k-1)  (= the end of step k-1)
    //   "end"        = the end of step k,   t = dt*k      ("end" always means the end of the step)
    //   "prev start" = the start of the PREVIOUS step, t = dt*(k-2)
    // The values in the this.* state fields (theta_osc, y_base, v_base, y_pivot, y_pivot_rel, v_pivot, x_bob, y_bob,
    //   v_bob_x, v_bob_y, angle_rod, F_rod_on_base) are as of the START of step k (the event: step k-1 has just ended;
    //   t = dt*(k-1)). They are read-only during step k. Positions and angles are the values at that time; v_pivot, v_bob_x and
    //   v_bob_y hold the velocity associated with step k-1; F_rod_on_base holds the force associated with step k-1 (overlay only;
    //   Change47: no longer applied in step k) (velocity, acceleration and force "associated with a step": see below).
    // The values in the matching *_end variables (theta_end, y_base_end, v_base_end, y_pivot_end, y_pivot_rel_end,
    //   v_pivot_end, x_bob_end, y_bob_end, v_bob_x_end, v_bob_y_end, angle_rod_end, F_rod_on_base_end) are as of the END of
    //   step k (the event: step k ends; t = dt*k). v_*_end are the velocities associated with step k; F_rod_on_base_end is the force
    //   associated with step k.
    // Velocity associated with step j (j = k-1 for the this.* fields, j = k for the *_end variables) is computed as
    //   (position at the end of step j - position at the start of step j) / dt, which happens to be the average velocity over step j,
    //   and happens to estimate the instantaneous velocity at t = dt*(j-1/2).
    // Acceleration associated with step k is computed as (velocity associated with step k - velocity associated with step k-1) / dt
    //   = (position at the end - 2*position at the start + position at the prev start) / dt^2, which happens to be a weighted average
    //   of the acceleration over steps k-1 and k, and happens to estimate the instantaneous acceleration at t = dt*(k-1).
    // Force associated with step k is computed from the acceleration associated with step k and the rod angle at the start of step k,
    //   and estimates the instantaneous force at t = dt*(k-1); Change47: the base update of step k applies it (no lag).
    // Interim calculation values (belong to neither set above):
    //   associated with step k (they estimate the instantaneous values at t = dt*(k-1)): a_base, this.v_pivot_c, this.a_pivot,
    //     this.a_pivot_along_rod, this.a_pivot_perp_rod, this.a_pivot_rod_x, this.a_pivot_rod_y, this.a_rod_on_bob,
    //     this.a_bob_x_calc, this.a_bob_y_calc, this.F_rod_on_pivot_x, this.F_rod_on_pivot_y, this.F_rod_on_bob_x,
    //     this.F_rod_on_bob_y (the last two are computed like the acceleration, from the change of the velocities associated with steps k-1 and k)
    //   at the prev start, t = dt*(k-2): y_pivot_rel_prev_start
    //   the predicted bob position at the end of step k, before the snap: x_temp, y_temp, x_temp_rel, y_temp_rel, dist_temp, angle_rod_predicted
    //   the bob velocity associated with step k-1 as used by the Verlet prediction: v_bob_x_start, v_bob_y_start (= this.v_bob_x / this.v_bob_y, except on the first step)
    //   at the end: this.F_spring_y (spring force on the base), this.constraint_correction (size of the snap)
    // The values in the this.* state fields are updated (committed) together, once, in the "Commit" block after section 5.
    // ── 1. Advance oscillator wheel ──────────────────────────────────────
    // The phase of a time j*dt is j % steps_per_cycle (phase 0 = crank up = top of stroke). The start of step k is at
    // time (k-1)*dt, so its phase is (k-1) % steps_per_cycle; the first phase check therefore runs in step 1 (time 0).
    // The pivot at the start of step k is the centre of the 3-point stencil (positions at (k-2)*dt, (k-1)*dt, k*dt) used in section 3b.
    // Change28 and Change29
    const phase_start = (k - 1) % p.steps_per_cycle; // Ch28-Edt: phase of the start of step k (time (k-1)*dt), derived from k; USED in 3b to know which stroke point the start-of-step sample is
    const theta_end = this._crankAngleAtStep(k); // Ch32-Edt: crank angle at the end of step k (time k*dt), computed from the step number k instead of being accumulated step by step; committed to this.theta_osc at the end of the step

    // New pivot y relative to base (crank-slider geometry, see _pivotRelYAtTheta).
    const y_pivot_rel_end = this._pivotRelYAtTheta(theta_end); // Ch32-Edt: pivot height above base at the end of step k (time k*dt), from the crank angle above; committed to this.y_pivot_rel at the end of the step

    // ── 2. Spring force on the base ───────────────────────────────────────
    // Change47: the base is no longer pushed by the rod force of the PREVIOUS step. That one-step
    // lag fed each step's rod force back into the next with a gain of about -(mass_bob/mass_base)·cos²(angle_rod): a damped
    // step-to-step zigzag for a base a few times heavier than the bob, an undamped one at equal masses, and a blow-up for a
    // lighter base (which then tripped the base-oscillation crash check within a few steps). The base acceleration and the rod
    // force are now solved together, for the same time (the start of step k), in section 3b; the base is then moved in
    // section 3c. Only the spring force, which depends on the base position alone, is computed here.
    // CLASSICAL mode: base is pinned exactly at rest — F_rod_on_base is still
    // computed in 3b (the rod still loads the mount), it just produces zero
    // motion, as if mass_base were infinite. The spring is skipped entirely, and the
    // base-oscillation crash check in 3c never fires (v_base stays 0).
    let F_spring = 0; // Ch47-Edt: spring restoring force F = −k · y_base on the base at the start of step k; zero in FREE mode (no spring) and in CLASSICAL mode (base pinned)
    if (!p.rigid_base && p.earth_mode) {
      F_spring = -p.k_spring * this.y_base; // spring force on the base at the start of step k (this.y_base is still the start-of-step value)
    }
    let a_base = 0; // Ch47-Edt: base acceleration at the start of step k; stays 0 for the rigid/CLASSICAL base, solved together with the rod force in section 3b for a movable base

    // ── 3b. Pivot kinematics + bob acceleration from the rod's contributions ──
    // Uses ONLY the pivot's deterministic motion and the bob's CURRENT state; it does not move the bob itself — section 4
    // does, from the a_bob_x_calc / a_bob_y_calc computed here. At its end it also computes the rod force on
    // the pivot and the force on the base (F_rod_on_base).
    //   1. pivot heights at the prev start / start / end (crank-triangle code, kept as is)
    //   2. sanity-check the phase bookkeeping at the stroke extremes and centre
    //   3. pivot speed and acceleration by central differences around the start of step k
    //   4. split the pivot acceleration along / perpendicular to the rod, then into horizontal / vertical
    //   5. add up the rod's three contributions to the bob acceleration — the pivot's along-rod share,
    //      the cancellation of gravity's along-rod share, and the centripetal term v_t^2/L — each split
    //      horizontal / vertical, plus gravity (0, -g) directly.
    let F_rod_on_base_end = 0; // Ch32-Add: force on the base found in this step (valid for the start of step k); committed to this.F_rod_on_base at the end of the step (Ch47-Edt: for the overlay; this step's base update already applied it)
    {
      const L         = p.L_rod; // rod length, used to normalise the rod direction
      const y_pivot_rel_prev_start = this._pivotRelYAtTheta(this._crankAngleAtStep(k - 2)); // Ch29-Edt: pivot height above base at the start of the previous step, dt*(k-2) — stored nowhere, recomputed here from the crank angle of step k-2 (same crank-triangle geometry)
      // Ch33-Edt: the 3 pivot heights above the base: at the start of the previous step, dt*(k-2) (y_pivot_rel_prev_start above); at the start of step k,
      // dt*(k-1) = this.y_pivot_rel — the MIDDLE sample, the velocity/acceleration below are for this time; at the end of step k, dt*k = y_pivot_rel_end (section 1).

      if (p.phase_steps_exact) this._checkPivotPhase(phase_start, y_pivot_rel_prev_start, this.y_pivot_rel, y_pivot_rel_end); // verify peak / stroke-centre positions and neighbouring samples at phases 0, q, 2q, 3q (skipped if dt was clamped)

      this.v_pivot_c = (y_pivot_rel_end - y_pivot_rel_prev_start) / (2 * dt) + this.v_base; // Ch32-Edt: pivot speed at the start of step k = crank-relative central difference + base velocity (this.v_base is still the start-of-step value)
      const a_pivot_crank = (y_pivot_rel_end - 2 * this.y_pivot_rel + y_pivot_rel_prev_start) / (dt * dt); // Ch47-Add: crank-relative part of the pivot acceleration at the start of step k (central second difference); the base acceleration is added once it is solved below

      const d_x   = this.x_bob;                 // horizontal offset of the bob from the pivot at the start of step k (pivot x is always 0)
      const d_y   = this.y_bob - this.y_pivot;  // Ch32-Edt: vertical offset of the bob from the pivot at the start of step k
      const sin_a = d_x / L;                    // sine of the rod angle (clockwise from upward vertical)
      const cos_a = d_y / L;                    // cosine of the rod angle (1 = upright, -1 = hanging)

      const v_rel_x = this.v_bob_x;                   // bob velocity relative to the pivot, horizontal (pivot has no horizontal motion)
      const v_rel_y = this.v_bob_y - this.v_pivot;    // Ch32-Edt: bob velocity relative to the pivot, vertical (both are averages over step k-1: the start-of-step values of the fields)
      const v_tan   = (v_rel_x * d_y - v_rel_y * d_x) / L; // bob speed perpendicular to the rod (cross product / L); radial part is ~0 by the constraint
      const g_rod_along = p.g * cos_a;               // Ch47-Edt: moved up from below (needed by the base solve) — size of the rod push (pivot -> bob) that cancels gravity's component along the rod
      const cent        = (v_tan * v_tan) / L;       // Ch47-Edt: moved up from below (needed by the base solve) — centripetal acceleration size needed to keep the bob on its circle (points bob -> pivot)

      // Change47: base acceleration and rod force solved together, for the same time (start of step k).
      // The rod's along-rod acceleration of the bob is  a_rod = (a_pivot_crank + a_base)·cos_a + g_rod_along − cent,
      // and the base feels the spring plus the vertical part of the opposite rod force:  mass_base·a_base = F_spring − mass_bob·a_rod·cos_a.
      // Substituting the first into the second and solving for a_base:
      //   a_base = (F_spring − mass_bob·cos_a·(a_pivot_crank·cos_a + g_rod_along − cent)) / (mass_base + mass_bob·cos_a²)
      // The extra mass_bob·cos_a² in the denominator is the bob riding along with the base: a light base gives way under the rod
      // instead of taking the full rod force. For a very heavy base it reduces to the old a_base ≈ (F_spring + F_rod_on_base) / mass_base.
      if (!p.rigid_base) { // Ch47-Add: a movable base (EARTH / FREE); in CLASSICAL mode a_base stays exactly 0
        a_base = (F_spring - p.mass_bob * cos_a * (a_pivot_crank * cos_a + g_rod_along - cent))
               / (p.mass_base + p.mass_bob * cos_a * cos_a); // Ch47-Add: base acceleration at the start of step k
      }
      this.a_pivot = a_pivot_crank + a_base; // Ch47-Edt: pivot acceleration at the start of step k = crank-relative part + base acceleration (now solved for the same step, no lag)

      this.a_pivot_along_rod = this.a_pivot * cos_a;                    // pivot acceleration projected on the rod direction (pivot -> bob)
      this.a_pivot_perp_rod  = -this.a_pivot * sin_a;                   // pivot acceleration projected on the clockwise tangent (cos_a, -sin_a), perpendicular to the rod
      this.a_pivot_rod_x     = this.a_pivot_along_rod * sin_a;          // horizontal component of the along-rod part
      this.a_pivot_rod_y     = this.a_pivot_along_rod * cos_a;          // vertical component of the along-rod part

      // Bob acceleration (inertial frame) built from three separate
      // rod contributions, each split into horizontal / vertical:
      //   1. the pivot's acceleration carried along the rod (a_pivot_rod_x / a_pivot_rod_y above)
      //   2. the rod cancelling gravity's along-rod share (rigidity: the bob cannot sink along the rod)
      //   3. the rod supplying the centripetal acceleration (the bob stays on its circle)
      // then gravity (0, -g) is added directly.
      const g_rod_x     = g_rod_along * sin_a;       // horizontal part of the gravity-cancelling rod push
      const g_rod_y     = g_rod_along * cos_a;       // vertical part of the gravity-cancelling rod push
      const cent_x      = -cent * sin_a;             // horizontal part of the centripetal acceleration (toward the pivot, so negative along the rod)
      const cent_y      = -cent * cos_a;             // vertical part of the centripetal acceleration

      this.a_rod_on_bob = this.a_pivot_along_rod + g_rod_along - cent; // acceleration the rod alone gives the bob along pivot -> bob = pivot's share + gravity cancellation - centripetal; multiplied by mass_bob below to get newtons for the force on the pivot
      this.a_bob_x_calc = this.a_pivot_rod_x + g_rod_x + cent_x;             // horizontal bob acceleration = pivot's share + gravity cancellation + centripetal (gravity has no horizontal part)
      this.a_bob_y_calc = -p.g + this.a_pivot_rod_y + g_rod_y + cent_y;      // vertical bob acceleration = gravity + pivot's share + gravity cancellation + centripetal

      // Force the rod puts on the PIVOT, and from it the force on the BASE, taken from the rod force alone. The rod is massless, so
      // its force on the pivot is equal and opposite to its force on the bob, which is mass_bob * a_rod_on_bob
      // along pivot -> bob. Split at the pivot into:
      //   vertical part   -> carried by the connecting arm and crank to the base (F_rod_on_base). Exact for any arm
      //                      tilt when the track is frictionless and slider/arm/wheel are massless, because the
      //                      slider is in vertical equilibrium.
      //   horizontal part -> absorbed entirely by the track (cylinder wall); real but not tracked
      //                      (see CLAUDE.md TODO: horizontal forces on piston cylinder).
      // This is the force for the start of step k. Ch47-Edt: it is the same force the base solve above used (mass_base·a_base =
      // F_spring + F_rod_on_pivot_y holds exactly), so there is no longer a one-step lag; it is committed at the end of the step
      // only for the force overlay.
      this.F_rod_on_pivot_x = -p.mass_bob * this.a_rod_on_bob * sin_a; // horizontal force (N) the rod puts on the pivot; opposite to the rod's push on the bob; absorbed by the track
      this.F_rod_on_pivot_y = -p.mass_bob * this.a_rod_on_bob * cos_a; // vertical force (N) the rod puts on the pivot; opposite to the rod's push on the bob (negative = downward)
      F_rod_on_base_end     = this.F_rod_on_pivot_y; // Ch47-Edt: vertical force (N) reaching the base, for the start of step k; committed to this.F_rod_on_base at the end of the step (for the overlay)
    }

    // ── 3c. Base update ───────────────────────────────────────────────────
    // Ch47-Edt: moved here from section 2, since a_base is now solved in 3b.
    let v_base_end = 0; // Ch32-Add: base velocity at the end of step k (committed to this.v_base at the end of the step)
    let y_base_end = 0; // Ch32-Add: base height at the end of step k (committed to this.y_base at the end of the step)
    if (!p.rigid_base) { // Ch32-Edt: a movable base (EARTH / FREE); in CLASSICAL mode both new values stay exactly 0
      v_base_end = this.v_base + a_base * dt; // Ch32-Edt: base velocity at the end of step k
      y_base_end = this.y_base + v_base_end * dt; // Ch32-Edt: base height at the end of step k (uses the new velocity)
    }

    // Base-oscillation "crash" check: live-measured steps per
    // full v_base cycle, via its own zero-crossings — half-cycle step count
    // doubled gives the full-cycle count.
    // It asks "is dt still resolving this," not "is this too large": there is deliberately no
    // limit on |v_base| or |y_base| — the base's motion is pure vertical
    // translation, so the rod-angle measurement stays valid no matter how extreme they get,
    // and there is no physical reason to stop on a large value.
    // In rigid_base (CLASSICAL) mode v_base stays exactly 0 always, so no
    // crossing is ever detected here — the check correctly never fires.
    // Change48: stop only after BASE_CRASH_CONSECUTIVE short half-cycles IN A ROW. A single short
    // half-cycle is a false alarm when the base velocity has a slow drift with the pivot-frequency shake riding on it (FREE
    // mode: the base sinks steadily under the bob's weight; EARTH: the slow spring swing): when the drift just matches the
    // shake's peak, v_base pokes across zero for a few steps only, and the half-cycles then alternate short / long. A real
    // resolution failure (e.g. a step-to-step zigzag, or a dt too coarse) makes EVERY half-cycle short. Also, the first
    // crossing of a run is only recorded, not measured, since there is no real earlier crossing to measure from.
    const vSign = v_base_end > 0 ? 1 : (v_base_end < 0 ? -1 : this._baseCrossSign); // Ch32-Edt: sign of the base velocity at the end of step k
    if (this._baseCrossSign !== null && vSign !== null && vSign !== this._baseCrossSign) {
      const firstCrossing = (this._baseCrossStep === 0); // Ch48-Add: no earlier crossing to measure from (k >= 1, so 0 means none yet)
      const stepsPerHalfCycle = k - this._baseCrossStep; // Ch28-Edt: steps since the last confirmed zero-crossing of v_base (k = this step's number)
      this._baseCrossStep = k; // Ch28-Edt: remember the step number of this zero-crossing
      const stepsPerFullCycle = stepsPerHalfCycle * 2;
      if (!firstCrossing) { // Ch48-Add
        this._baseShortCount = (stepsPerFullCycle < BASE_CRASH_STEPS_PER_CYCLE) ? this._baseShortCount + 1 : 0; // Ch48-Add: count short half-cycles in a row; any normal one resets the count
      }
      if (this._baseShortCount >= BASE_CRASH_CONSECUTIVE) { // Ch48-Edt: was "stepsPerFullCycle < BASE_CRASH_STEPS_PER_CYCLE" (a single short half-cycle)
        this.status     = 'stopped';
        this.stopReason = `Base oscillation under-resolved: ~${stepsPerFullCycle} steps/cycle (min ${BASE_CRASH_STEPS_PER_CYCLE}) — dt too coarse to trust these numbers.`;
        console.warn('[Kapitza] Stop:', this.stopReason);
        return;
      }
    }
    this._baseCrossSign = vSign;

    // ── 3d. Update absolute pivot position ───────────────────────────────
    // Ch47-Edt: moved here from section 3 (after the base update in 3c, which it needs).
    const y_pivot_end = y_pivot_rel_end + y_base_end; // Ch32-Edt: absolute pivot height at the end of step k (time k*dt) = crank height + base height at the end of step k
    const v_pivot_end = (y_pivot_end - this.y_pivot) / dt; // Ch32-Edt: pivot velocity averaged over step k (two points: end of step k minus start of step k, over dt); also what the charts show; committed to this.v_pivot at the end of the step

    // ── 4. Bob update — Verlet prediction from the 3b acceleration + snap to the rod circle ──
    // (The earlier dog-leash and Lagrange-multiplier schemes and their derivations: see conversation.)
    //   (a) predict the bob's position at the end of step k from the section-3b acceleration (gravity and the rod force
    //       are already inside it) with the Stormer-Verlet (leapfrog) update
    //   (b) snap the predicted position to the nearest point of the circle of radius L_rod around the
    //       pivot at the end of step k (y_pivot_end, from section 3)
    //   (c) new velocity = realized displacement / dt
    //   (d) force the rod exerts on the bob, for the renderer's force overlay
    // Ch32-Edt: this.x_bob, this.y_bob, this.v_bob_x and this.v_bob_y still hold the start-of-step values here (they are
    // committed only at the end of the step), so no copies of them are needed.

    // (a) Prediction with the full bob acceleration from section 3b (gravity + rod force: pivot's share, gravity cancellation, centripetal) using the
    // Stormer-Verlet (leapfrog) update:  x_end = x_start + v_avg(step k-1)*dt + a_start*dt^2.
    // The stored velocity is the AVERAGE over step k-1, not the instantaneous velocity at the start, so the
    // acceleration term carries a full a*dt^2 (a 1/2 factor would lose half of the acceleration on every step).
    // On the very first step the held velocity is the instantaneous start velocity, not an average, so it
    // is first converted to the average convention by backing it up half a step: v_avg = v0 - a*dt/2.
    const first_step       = (k === 1); // Ch28-Edt: true only on the first step of a run (k is the number of the step being executed)
    const v_bob_x_start = first_step ? this.v_bob_x - 0.5 * this.a_bob_x_calc * dt : this.v_bob_x; // Ch32-Edt: bob x velocity averaged over step k-1 (= this.v_bob_x); first step: start velocity v0 backed up half a step (v0 - a*dt/2)
    const v_bob_y_start = first_step ? this.v_bob_y - 0.5 * this.a_bob_y_calc * dt : this.v_bob_y; // Ch32-Edt: bob y velocity averaged over step k-1 (= this.v_bob_y); first step: start velocity v0 backed up half a step (v0 - a*dt/2)
    const x_temp = this.x_bob + v_bob_x_start * dt + this.a_bob_x_calc * dt * dt; // Ch32-Edt: predicted bob x at the end of step k = x at the start + average velocity of step k-1 * dt + acceleration * dt^2
    const y_temp = this.y_bob + v_bob_y_start * dt + this.a_bob_y_calc * dt * dt; // Ch32-Edt: predicted bob y at the end of step k, same form (gravity is already inside a_bob_y_calc)
    // The correction (b) below only removes a small residual, since the prediction already carries the
    // rod force; its size is recorded in this.constraint_correction as a self-check.

    // (b) Snap the predicted bob to the NEAREST point of the circle of radius L_rod around the NEW pivot, i.e. move it along the radius from the new pivot
    // through the predicted position. This is a CHOICE, made because it is the smallest displacement that satisfies the one constraint
    // we know for certain (rod length) — NOT because this radius is known to be the correct one. The predicted
    // position, and therefore the rod angle read from it, may already contain error (integration, the half-step-
    // lagged centripetal term, the pivot-acceleration stencil, ...) that has never been quantified, and that
    // error may lie along the circle as well as across it. The snap removes only the part that takes the bob off
    // the circle; it cannot see or fix the rest.
    const x_temp_rel = x_temp;                                      // predicted (temp) bob x relative to the new pivot (pivot x is always 0)
    const y_temp_rel = y_temp - y_pivot_end;                        // Ch32-Edt: predicted (temp) bob y relative to the pivot at the end of step k (section 3)
    const dist_temp  = Math.hypot(x_temp_rel, y_temp_rel);          // distance of the predicted (temp) bob from the new pivot; would equal L_rod if the prediction were exactly on the circle
    const angle_rod_predicted = Math.atan2(x_temp_rel, y_temp_rel); // rod angle of the predicted position (clockwise from upward vertical, same convention as angle_rod) — the radius direction we snap along

    const x_bob_end = p.L_rod * Math.sin(angle_rod_predicted);                 // Ch32-Edt: bob x at the end of step k, on the circle around the pivot at the end of step k; committed to this.x_bob at the end of the step
    const y_bob_end = y_pivot_end + p.L_rod * Math.cos(angle_rod_predicted);   // Ch32-Edt: bob y at the end of step k, on the circle around the pivot at the end of step k; committed to this.y_bob at the end of the step
    this.constraint_correction = Math.abs(dist_temp - p.L_rod);          // size (m) of the snap applied this step; near zero means the 3b acceleration already respects the rod length — measures only the off-circle part of the error

    // (c) New velocity = realized displacement / dt
    //     This implicitly removes any radial velocity artifact.
    const v_bob_x_end = (x_bob_end - this.x_bob) / dt; // Ch32-Edt: bob x velocity averaged over step k (end of step k minus start of step k, over dt); committed to this.v_bob_x at the end of the step
    const v_bob_y_end = (y_bob_end - this.y_bob) / dt; // Ch32-Edt: bob y velocity averaged over step k; committed to this.v_bob_y at the end of the step

    // (d) Force the rod exerts on the bob, from the bob's realized velocity change: F = m·(a + g); it is
    //     what the renderer's force overlay reads. (The force on the base is NOT taken from here — it comes
    //     from the rod force in section 3b.)
    //
    // — force chain: rod (massless) -> pivot -> crank arm -> base.
    //   1. Rod is massless, so Newton's 2nd law forces zero net force on it:
    //      F_rod_on_pivot = -F_rod_on_bob (full vector, both x and y, exact —
    //      whatever the rod delivers at the bob end arrives unchanged and
    //      flipped at the pivot end; no approximation needed for this step).
    //   2. x_pivot is pinned to exactly 0 (the crank-slider's cylinder wall
    //      constrains it) — that wall can only push horizontally, so it
    //      absorbs F_rod_on_pivot's x-component entirely. That force is real
    //      but untracked here (see CLAUDE.md TODO: horizontal forces on piston cylinder).
    //   3. The crank arm carries the y-component on to the base. This step
    //      assumes r_osc << L_arm (ratio_arm_to_amplitude >> 1, see _derive()):
    //      it keeps the arm's own tilt negligible, so the arm contributes ~0
    //      horizontal force of its own (leaving the wall to absorb all of it)
    //      and passes the y-component through to the base essentially intact.
    //      F_rod_on_base (assigned in section 3b) is exactly that surviving y-component.
    const a_bob_y = (v_bob_y_end - this.v_bob_y) / dt; // Ch32-Edt: change of the bob's average velocity from step k-1 (this.v_bob_y) to step k, per dt
    const a_bob_x = (v_bob_x_end - this.v_bob_x) / dt; // Ch32-Edt: same for x
    this.F_rod_on_bob_x = p.mass_bob * a_bob_x;
    this.F_rod_on_bob_y = p.mass_bob * (a_bob_y + p.g); // 
    this.F_spring_y = 0;
    if (p.earth_mode) {
      this.F_spring_y = -p.k_spring * y_base_end; // Ch32-Edt: spring force on the base at the end of step k (for the overlay)
    }

    // ── 5. Rod angle at the end of the step ───────────────────────────────
    // atan2(x, y_above_pivot) gives angle from upward vertical, clockwise
    const angle_rod_end = Math.atan2(x_bob_end, y_bob_end - y_pivot_end); // Ch32-Edt: rod angle at the end of step k; committed to this.angle_rod below

    // ── Commit ─────────────────────────────────────────────────────────────
    // Ch32-Add: the only place where the carried state fields are assigned: from here on they hold the values
    // at the END of step k (time k*dt), which are the start-of-step values of step k+1.
    this.theta_osc     = theta_end;         // Ch32-Add: crank angle at time k*dt
    this.v_base        = v_base_end;        // Ch32-Add: base velocity
    this.y_base        = y_base_end;        // Ch32-Add: base height
    this.v_pivot       = v_pivot_end;       // Ch32-Add: pivot velocity, average over step k
    this.y_pivot_rel   = y_pivot_rel_end;   // Ch32-Add: pivot height above the base
    this.y_pivot       = y_pivot_end;       // Ch32-Add: absolute pivot height
    this.x_bob         = x_bob_end;         // Ch32-Add: bob x
    this.y_bob         = y_bob_end;         // Ch32-Add: bob y
    this.v_bob_x       = v_bob_x_end;       // Ch32-Add: bob x velocity, average over step k
    this.v_bob_y       = v_bob_y_end;       // Ch32-Add: bob y velocity, average over step k
    this.angle_rod     = angle_rod_end;     // Ch32-Add: rod angle
    this.F_rod_on_base = F_rod_on_base_end; // Ch47-Edt: force on the base for the start of step k (already applied in this step's base update); kept for the force overlay

    // ── 5b. Swing extremum tracking ─────────────────────────────
    this._trackSwing(this.angle_rod * 180 / Math.PI);

    // ── 6. Target-angle stop ─────────────────────────────────────────────────
    // Halt as soon as |angle_rod| reaches stop_angle_deg (default 90°; can be
    // lowered to measure time-to-angle for smaller targets, or disabled via
    // the slider at 0/off, in which case the run continues indefinitely
    // unless another stop fires — see step 2's base-oscillation check and
    // section 7's sim-vs-analytical checks).
    if (p.stop_angle_deg != null &&
        this.status === 'running' &&
        Math.abs(this.angle_rod) * 180 / Math.PI >= p.stop_angle_deg) {
      this.status     = 'target_reached';
      this.stopReason = `stop angle reached (${p.stop_angle_deg}°)`;
    }

    // ── 7. Sim-vs-analytical (ODE) comparison ──────────────────
    // Independent ODEa trajectory: integrated every step from its own state
    // only (angle_rod is never read here) — this is what keeps the
    // comparison a fair, non-strawman one (see conversation on CLASSICAL-
    // only scoping).
    if (this._odeaCompareActive()) {
      const ode_accel = (p.g / p.L_rod) * Math.sin(this.ODEa_angle)
                       - (p.V_Hat_Sim / (p.L_rod ** 2)) * Math.cos(this.ODEa_angle) * Math.sin(this.ODEa_angle);
      this.ODEa_angVel += ode_accel * dt;
      this.ODEa_angle  += this.ODEa_angVel * dt;
    }

    // ── 8. Advance time and record history ────────────────────────────────
    this.t += dt;

    // Dedicated rod-angle ring buffer write — always on, independent of
    // history_window_s.
    {
      const cap = this.angleHistT.length;
      this.angleHistT[this.angleHistPos]   = this.t;
      this.angleHistDeg[this.angleHistPos] = this.angle_rod * 180 / Math.PI;
      this.angleHistPos = (this.angleHistPos + 1) % cap;
      if (this.angleHistCount < cap) this.angleHistCount++;
    }

    // Change50: sliding 1 s average base speed and acceleration (see reset()).
    {
      const cap = this.baseHistY.length;              //Ch50-Add
      const N   = p.baseHistStepsPerSec;              //Ch50-Add: steps in the ~1 s window
      const win = N * dt;                             //Ch50-Add: exact window length (s)
      this.baseHistY[this.baseHistPos] = this.y_base; //Ch50-Add: end-of-step y_base (committed above)
      const now = this.baseHistPos;                   //Ch50-Add
      this.baseHistPos = (this.baseHistPos + 1) % cap;           //Ch50-Add
      if (this.baseHistCount < cap) this.baseHistCount++;        //Ch50-Add
      if (this.baseHistCount > N) {                              //Ch50-Add: y(t−1 s) exists
        const y1 = this.baseHistY[(now - N + cap) % cap];        //Ch50-Add
        this.v_base_1s = (this.y_base - y1) / win;               //Ch50-Add
        if (this.baseHistCount > 2 * N) {                        //Ch50-Add: y(t−2 s) exists
          const y2 = this.baseHistY[(now - 2 * N + cap) % cap];  //Ch50-Add
          this.a_base_1s = (this.y_base - 2 * y1 + y2) / (win * win); //Ch50-Add
        }
      }
    }

    // Run-time-limit stop: halt once elapsed sim time reaches
    // time_limit_s (default 20s), independent of any angle-based stop.
    // Checked after the time advance above so this.t is up to date.
    if (p.time_limit_s != null &&
        this.status === 'running' &&
        this.t >= p.time_limit_s) {
      this.status     = 'target_reached';
      this.stopReason = `time limit reached (${p.time_limit_s}s)`;
    }

    // maxHistory === 0 means history_window_s <= 0 (disabled) — skip the
    // shift()/push() entirely rather than just capping at zero length.
    if (this.maxHistory > 0) {
      if (this.history.length >= this.maxHistory) this.history.shift();
      this.history.push({
        t:              this.t,
        angle_deg:      this.angle_rod   * 180 / Math.PI,
        y_base_mm:      this.y_base      * 1000,
        y_pivot_mm:     this.y_pivot     * 1000,
        y_pivot_rel_mm: this.y_pivot_rel * 1000,
        v_base:         this.v_base,
        v_pivot:        this.v_pivot,
      });
    }

    // Stroboscopic sample — one per full pivot cycle.
    if (this._odeaCompareActive() && k % p.steps_per_cycle === 0) { // Ch28-Edt: k (= this._stepCount) is a multiple of steps_per_cycle: the end of step k is at phase 0
      this._recordChange22Sample();
    }
  }

  // ── pivot geometry / phase helpers ──────────────────────────────

  /**
   * Pivot height above the base (wheel centre) for a given crank angle: the single place
   * that holds the crank-slider (crank-arm triangle) geometry. Used by reset(), step() section 1,
   * the 3-point stencil in section 3b and _computeVHatSim(). Throws if the crank radius is
   * not smaller than the connecting-arm length.
   * Change31
   */
  _pivotRelYAtTheta(theta) {
    const p      = this.params; // current parameters (arm length, crank radius)
    const x_carm = p.r_osc * Math.sin(theta); // horizontal offset of the crank-arm tip from the wheel centre
    const y_carm = p.r_osc * Math.cos(theta); // vertical offset of the crank-arm tip from the wheel centre
    const discriminant = p.L_arm ** 2 - x_carm ** 2; // Ch31-Add: (arm length)^2 - (tip horizontal offset)^2; always positive because x_carm <= r_osc << L_arm
    if (discriminant < 0) throw new Error( // Ch31-Add: geometry check, now applied to every caller
      `Crank-slider geometry violated: r_osc (${p.r_osc}) >= L_arm (${p.L_arm})`); // Ch31-Add: error text when the crank radius is not smaller than the arm length
    return Math.sqrt(discriminant) + y_carm; // triangle height of the connecting arm plus the crank-tip height = pivot height above base
  }

  /**
   * Crank angle (rad, 0 = arm pointing up, clockwise) at time j*dt, computed from the
   * integer step index j instead of adding omega*dt step after step (no accumulated rounding error).
   * When exactly steps_per_cycle steps fit in one pivot period (p.phase_steps_exact) it is
   * 2*pi*(j % steps_per_cycle)/steps_per_cycle; otherwise (clamped dt, or frequency 0) it is (omega*dt*j) % 2*pi.
   * j may be zero or negative (the pivot one or two steps before time 0 is needed by the 3-point stencil at k=1).
   * Change29
   * @param {number} j  step index: the angle at time j*dt
   */
  _crankAngleAtStep(j) {
    const p     = this.params; // current parameters (steps per cycle, omega, dt)
    const twoPi = 2 * Math.PI; // full turn of the crank (rad)
    if (p.phase_steps_exact) { // exactly steps_per_cycle steps fit in one pivot period
      const jc = ((j % p.steps_per_cycle) + p.steps_per_cycle) % p.steps_per_cycle; // Ch29-Add: j wrapped into 0..steps_per_cycle-1, also for negative j
      return twoPi * jc / p.steps_per_cycle; // Ch29-Add: exact fraction of a turn for that phase index
    }
    return (((p.omega_osc * p.dt * j) % twoPi) + twoPi) % twoPi; // Ch29-Add: clamped dt or frequency 0: angle from omega*dt*j, wrapped into 0..2*pi also for negative j
  }

  /**
   * Sanity-check that the integer phase counter really sits where the crank
   * geometry says it should (diagnostics only — warns once, counts failures,
   * never stops the run). phase 0 = top of stroke, steps_per_half_cycle =
   * bottom, and steps_per_amplitude (quarter cycle) / that + half cycle =
   * the two crossings of the stroke centre.
   * @param {number} phase   phase of the pivot at the start of step k, time dt*(k-1): (k-1) % steps_per_cycle (Change28 and Change33)
   * @param {number} y_prev  pivot height above base one step before it
   * @param {number} y_old   pivot height above base at it
   * @param {number} y_next  pivot height above base one step after it
   * @returns {boolean} true if the check passed (or nothing to check at this phase)
   */
  _checkPivotPhase(phase, y_prev, y_old, y_next) {
    const p   = this.params; // current parameters
    const q   = p.steps_per_cycle / 4; // steps per amplitude = steps per quarter cycle (integer, see _derive)
    const tol = 1e-12 * p.L_arm; // absolute tolerance for "is at the exact extreme height" (well above float round-off)
    let ok = true; // result of this check
    let where = ''; // label of the checked phase point, for the warning message

    if (phase === 0) { // top of the stroke
      where = 'top of stroke'; // label
      ok = y_old >= y_prev && y_old >= y_next && Math.abs(y_old - (p.L_arm + p.r_osc)) <= tol; // highest of the three samples (neighbours lie below on both sides) and at the full-stroke height L_arm + r
    } else if (phase === 2 * q) { // bottom of the stroke (half cycle)
      where = 'bottom of stroke'; // label
      ok = y_old <= y_prev && y_old <= y_next && Math.abs(y_old - (p.L_arm - p.r_osc)) <= tol; // lowest of the three samples (neighbours lie above on both sides) and at the height L_arm - r
    } else if (phase === q || phase === 3 * q) { // the two passes through the middle of the stroke
      where = 'centre of stroke'; // label
      const y_centre = p.L_arm; // middle of the stroke = average of top (L_arm + r) and bottom (L_arm - r)
      const d_old    = Math.abs(y_old  - y_centre); // distance of the old sample from the stroke centre
      const d_prev   = Math.abs(y_prev - y_centre); // distance of the previous sample from the stroke centre
      const d_next   = Math.abs(y_next - y_centre); // distance of the next sample from the stroke centre
      const monotonic = (phase === q)
        ? (y_prev > y_old && y_old > y_next)   // first pass moves downward: previous above, next below
        : (y_prev < y_old && y_old < y_next);  // second pass moves upward: previous below, next above
      ok = monotonic && d_old <= d_prev && d_old <= d_next; // neighbours on the correct sides AND neither neighbour closer to the centre than the old sample
    } else {
      return true; // no expected geometry at other phases — nothing to check
    }

    if (!ok) { // check failed
      this._phaseCheckFailures++; // count the failure
      if (this._phaseCheckFailures === 1) { // warn only the first time to avoid flooding the console
        console.warn(`[Kapitza] Pivot phase check failed at ${where}: phase step ${phase}/${p.steps_per_cycle}, heights prev=${y_prev} old=${y_old} next=${y_next}`);
      }
    }
    return ok; // report the result to the caller
  }

  // ── Swing extremum tracking ─────────────────────────────────────

  /**
   * Update swing_max/min tracking for this step's angle_rod (deg). Extends
   * the running peak/trough on the current side (not yet displayed), and
   * finalizes it as a confirmed swing — updating swing_max_deg/swing_min_deg
   * — on a debounced zero-crossing (period_pivot/2). swing_max_deg/swing_min_deg update
   * ONLY on a confirmed swing-back, not live — a fall (no crossing, angle_rod
   * grows one-directionally toward the stop angle) never shows up in
   * sMax/sMin at all; they stay at whatever the last genuine completed swing
   * was.
   */
  _trackSwing(angleDeg) {
    // Unconditional running max/min since t=0 — see angle_max_deg/
    // angle_min_deg comment in reset().
    if (angleDeg > this.angle_max_deg) this.angle_max_deg = angleDeg;
    if (angleDeg < this.angle_min_deg) this.angle_min_deg = angleDeg;

    const DEBOUNCE_S = this.params.period_pivot / 2;
    const s = angleDeg > 0 ? 1 : (angleDeg < 0 ? -1 : this._swingSign);

    if (s === this._swingSign) {
      // still on the same side — extend the running peak/trough. Not
      // reflected in swing_max_deg/swing_min_deg until confirmed below.
      this._swingRunPeak = this._swingSign > 0
        ? Math.max(this._swingRunPeak, angleDeg)
        : Math.min(this._swingRunPeak, angleDeg);
      this._swingPendingSign = null;
    } else {
      // opposite sign observed — debounce before treating it as a real crossing
      if (this._swingPendingSign !== s) {
        this._swingPendingSign  = s;
        this._swingPendingSince = this.t;
      } else if (this.t - this._swingPendingSince >= DEBOUNCE_S) {
        // confirmed crossing: the side we were just on completed a swing —
        // _confirmSwingExtreme() updates swing_max_deg/swing_min_deg itself.
        this._confirmSwingExtreme(this._swingSign > 0 ? 'max' : 'min', this._swingRunPeak, this.t);
        this._swingSign         = s;
        this._swingRunPeak      = angleDeg;
        this._swingPendingSign  = null;
      }
      // else: still within the debounce window — treat as ripple, keep
      // extending the running peak/trough on the original side (a return
      // to that side before the window elapses cancels the pending flip).
    }

    this.swing_angle_total_deg = this.swing_max_deg - this.swing_min_deg;
  }

  /**
   * Record a newly confirmed local max/min: update the displayed
   * swing_max_deg/swing_min_deg, push into that side's rolling buffer,
   * refresh its smoothed rate, and refresh the total-span log rate from the
   * new (confirmed-side, held-other-side) pairing. Runs unconditionally on
   * every confirmed crossing — independent of whatever the renderer's
   * convergence-ready display gate is doing.
   */
  _confirmSwingExtreme(side, deg, t) {
    if (side === 'max') this.swing_max_deg = deg; else this.swing_min_deg = deg;

    const buf = side === 'max' ? this._swingMaxBuf : this._swingMinBuf;
    buf.push({ deg, t });
    if (buf.length > SWING_RATE_WINDOW) buf.shift();

    if (buf.length >= 2) {
      const oldest = buf[0];
      const newest = buf[buf.length - 1];
      const rate = (newest.deg - oldest.deg) / (newest.t - oldest.t);
      if (side === 'max') this.swing_max_rate = rate;
      else                 this.swing_min_rate = rate;
    }

    const totalDeg = side === 'max'
      ? deg - this.swing_min_deg
      : this.swing_max_deg - deg;

    this._swingTotalBuf.push({ deg: totalDeg, t });
    if (this._swingTotalBuf.length > SWING_RATE_WINDOW) this._swingTotalBuf.shift();

    if (this._swingTotalBuf.length >= 2) {
      const oldest = this._swingTotalBuf[0];
      const newest = this._swingTotalBuf[this._swingTotalBuf.length - 1];
      // Guard: totalDeg should always be >=0 by construction (max>=min); skip
      // the log if a degenerate (zero/near-zero) value ever slips through.
      if (oldest.deg > 0 && newest.deg > 0) {
        this.swing_total_log_rate = Math.log(newest.deg / oldest.deg) / (newest.t - oldest.t);
      }
    }
  }

  /**
   * push one stroboscopic (once-per-full-pivot-cycle) sample for
   * the sim-vs-analytical (ODE) comparison, and run its two independent
   * stop checks — CLASSICAL mode only (see _odeaCompareActive()).
   *
   *   (1) Global/cumulative check: the sim's own angle against the
   *       independently-integrated ODEa_angle trajectory (from step()'s
   *       section 7 — never resynced from angle_rod). Catches errors that
   *       might otherwise partially cancel out and look fine locally.
   *   (2) Local/instantaneous check: the sim's own smoothed angular
   *       acceleration (finite-differenced from angleRodSmoothHist) against
   *       the ODEa formula evaluated at that SAME sim angle (legitimate
   *       only in CLASSICAL mode — see straw-man discussion). Catches a
   *       problem the moment it happens, before it's had time to
   *       accumulate into a visible angle difference.
   *
   * Both checks use a relative threshold plus a small absolute floor (see
   * ODEa_ANGLE_DIVERGENCE_REL/FLOOR, ODEa_ACCEL_DIVERGENCE_REL/FLOOR) — exact
   * equality is never expected (numerical integration error alone
   * guarantees some drift). All four *Hist arrays are separate,
   * self-contained {t,value} histories — never sharing storage or indices
   * between the sim-side and ODEa-side values.
   */
  _recordChange22Sample() {
    const p = this.params;
    const dtSample = p.steps_per_cycle * p.dt; // real time between samples

    this.ODEa_angleHist.push({ t: this.t, value: this.ODEa_angle });
    this.angleRodSmoothHist.push({ t: this.t, value: this.angle_rod });
    const n = this.angleRodSmoothHist.length;

    // (1) Global (cumulative) check: sim angle vs. independent ODEa trajectory.
    {
      const simAngle = this.angleRodSmoothHist[n - 1].value;
      const odeAngle = this.ODEa_angleHist[this.ODEa_angleHist.length - 1].value;
      const diff     = Math.abs(simAngle - odeAngle);
      const limit    = ODEa_ANGLE_DIVERGENCE_REL * Math.abs(odeAngle) + ODEa_ANGLE_DIVERGENCE_FLOOR;
      if (diff > limit) this._noteOdeMismatch('angle'); //Ch53b-Add
      if (diff > limit && p.stop_on_ode_mismatch) { //Ch53-Edt: added "&& p.stop_on_ode_mismatch" — switch off = keep running
        this.status     = 'stopped';
        this.stopReason = `ODEa angle-trajectory mismatch: sim angle_rod ${(simAngle * 180 / Math.PI).toFixed(3)}° `
                         + `vs ODEa_angle ${(odeAngle * 180 / Math.PI).toFixed(3)}° (diff ${(diff * 180 / Math.PI).toFixed(3)}°, `
                         + `limit ${(limit * 180 / Math.PI).toFixed(3)}°) at t=${this.t.toFixed(3)}s.`;
        console.warn('[Kapitza] Stop:', this.stopReason);
        return;
      }
    }

    if (n < 2) return;

    const vel = (this.angleRodSmoothHist[n - 1].value - this.angleRodSmoothHist[n - 2].value) / dtSample;
    this.angVelSmoothHist.push({ t: this.t, value: vel });
    if (this.angVelSmoothHist.length < 2) return;

    const nv  = this.angVelSmoothHist.length;
    const acc = (this.angVelSmoothHist[nv - 1].value - this.angVelSmoothHist[nv - 2].value) / dtSample;
    this.angAccSmoothHist.push({ t: this.t, value: acc });

    const theta    = this.angleRodSmoothHist[n - 1].value;
    const odeAccel = (p.g / p.L_rod) * Math.sin(theta)
                    - (p.V_Hat_Sim / (p.L_rod ** 2)) * Math.cos(theta) * Math.sin(theta);
    this.ODEa_accelHist.push({ t: this.t, value: odeAccel });

    // (2) Local (instantaneous) check: sim's smoothed acceleration vs. the
    // ODEa formula at that same angle.
    const accDiff  = Math.abs(acc - odeAccel);
    const accLimit = ODEa_ACCEL_DIVERGENCE_REL * Math.abs(odeAccel) + ODEa_ACCEL_DIVERGENCE_FLOOR;
    if (accDiff > accLimit && this.t >= ODEa_ACCEL_TIGHT_GRACE_S) this._noteOdeMismatch('accel'); //Ch53b-Add
    if (accDiff > accLimit && this.t >= ODEa_ACCEL_TIGHT_GRACE_S && p.stop_on_ode_mismatch) { //Ch53-Edt: added "&& p.stop_on_ode_mismatch" //Ch37-Edt: added "&& this.t >= ODEa_ACCEL_TIGHT_GRACE_S" — before the grace period elapses, a mismatch is silently ignored (see Change37 above); the underlying angAccSmoothHist/ODEa_accelHist pushes above are unconditional, so chart 6 still shows the discrepancy either way
      this.status     = 'stopped';
      this.stopReason = `ODEa acceleration mismatch: sim accel ${acc.toFixed(4)} rad/s^2 `
                       + `vs ODEa_accel ${odeAccel.toFixed(4)} rad/s^2 (diff ${accDiff.toFixed(4)}, `
                       + `limit ${accLimit.toFixed(4)}) at angle ${(theta * 180 / Math.PI).toFixed(2)}°, `
                       + `t=${this.t.toFixed(3)}s.`;
      console.warn('[Kapitza] Stop:', this.stopReason);
    }

    // (3) Wide/"doubly smoothed" acceleration check (a proper
    // apples-to-apples comparison): IDENTICAL
    // two-step finite-difference procedure applied to BOTH the sim's angle
    // and the ODEa shadow trajectory — see the constant block's comment.
    // dtWide = (N-1) intervals, matching the (N-1)-apart samples actually
    // being differenced.
    const dtWide = (ODEa_ACCEL_WIDE_N - 1) * dtSample;

    // Sim side: angle -> wide velocity -> wide acceleration.
    if (n >= ODEa_ACCEL_WIDE_N) {
      const velWide = (this.angleRodSmoothHist[n - 1].value - this.angleRodSmoothHist[n - ODEa_ACCEL_WIDE_N].value) / dtWide;
      this.angVelWideHist.push({ t: this.t, value: velWide });
    }
    const nvw = this.angVelWideHist.length;
    if (nvw >= ODEa_ACCEL_WIDE_N) {
      const accWide = (this.angVelWideHist[nvw - 1].value - this.angVelWideHist[nvw - ODEa_ACCEL_WIDE_N].value) / dtWide;
      this.angAccWideHist.push({ t: this.t, value: accWide });
    }

    // ODEa side: identical construction, applied to ODEa_angleHist.
    const nOde = this.ODEa_angleHist.length;
    if (nOde >= ODEa_ACCEL_WIDE_N) {
      const odeVelWide = (this.ODEa_angleHist[nOde - 1].value - this.ODEa_angleHist[nOde - ODEa_ACCEL_WIDE_N].value) / dtWide;
      this.ODEa_angVelWideHist.push({ t: this.t, value: odeVelWide });
    }
    const nOvw = this.ODEa_angVelWideHist.length;
    if (nOvw >= ODEa_ACCEL_WIDE_N) {
      const odeAccWide = (this.ODEa_angVelWideHist[nOvw - 1].value - this.ODEa_angVelWideHist[nOvw - ODEa_ACCEL_WIDE_N].value) / dtWide;
      this.ODEa_accelWideHist.push({ t: this.t, value: odeAccWide });
    }

    // Apples-to-apples comparison: both sides built the same way.
    if (this.angAccWideHist.length > 0 && this.ODEa_accelWideHist.length > 0) {
      const accWide    = this.angAccWideHist[this.angAccWideHist.length - 1].value;
      const odeAccWide = this.ODEa_accelWideHist[this.ODEa_accelWideHist.length - 1].value;
      const wideDiff   = Math.abs(accWide - odeAccWide);
      const wideLimit  = ODEa_ACCEL_WIDE_DIVERGENCE_REL * Math.abs(odeAccWide) + ODEa_ACCEL_WIDE_DIVERGENCE_FLOOR;
      if (wideDiff > wideLimit) this._noteOdeMismatch('wideAcc'); //Ch53b-Add
      if (wideDiff > wideLimit && p.stop_on_ode_mismatch) { //Ch53-Edt: added "&& p.stop_on_ode_mismatch"
        this.status     = 'stopped';
        this.stopReason = `ODEa wide-acceleration mismatch: sim accel (wide, N=${ODEa_ACCEL_WIDE_N}) ${accWide.toFixed(4)} rad/s^2 `
                         + `vs ODEa_accel (wide, same method) ${odeAccWide.toFixed(4)} rad/s^2 (diff ${wideDiff.toFixed(4)}, `
                         + `limit ${wideLimit.toFixed(4)}) at t=${this.t.toFixed(3)}s.`;
        console.warn('[Kapitza] Stop:', this.stopReason);
      }
    }
  }

  /**
   * Change53b: remember the FIRST sim-vs-ODEa mismatch of the run (later ones are ignored).
   * @param {string} kind 'angle' | 'accel' | 'wideAcc' — which of the three checks in _recordChange22Sample() fired
   */
  _noteOdeMismatch(kind) { //Ch53b-Add
    if (this.odeMismatchFirst === null) this.odeMismatchFirst = { t: this.t, kind }; //Ch53b-Add
  }

  /**
   * Run n steps in one call (used for fast-forward simulation).
   * Stops early if the pendulum falls.
   * @param {number} n
   */
  stepN(n) {
    for (let i = 0; i < n; i++) {
      this.step();
      if (this.status === 'stopped' || this.status === 'target_reached') break;
    }
  }
}
