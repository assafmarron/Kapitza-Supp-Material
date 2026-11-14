/**
 * renderer.js — Kapitza Pendulum Scene Renderer
 *
 * Draws the physical scene onto a <canvas> element each animation frame.
 *
 * Scene elements (drawn bottom-to-top):
 *   1. Background gradient + subtle scanlines (dark mode only)
 *   2. Hatched ground
 *   3. Zigzag spring
 *   4. Base platform (moves with spring)
 *   5. Oscillator wheel (rotating) + crank arm
 *   6. Cylinder guide (dashed vertical line)
 *   7. Connecting arm (crank pin → pivot)
 *   8. Pivot point
 *   9. Bob trail (fading arc)
 *  10. Pendulum rod
 *  11. Bob (glows cyan/blue when stable, reddens with rod angle)
 *  12. Angle indicator arc at pivot
 *  13. Overlay text (θ, t)
 *
 * Coordinate mapping:
 *   Physics uses y-UP (SI metres, origin at base/wheel centre).
 *   Canvas uses y-DOWN (pixels, origin at top-left).
 *   toCanvas(px, py) = { x: originX + px*scale, y: originY − py*scale }
 *
 * Theming:
 *   _isLight() checks document.documentElement.dataset.theme === 'light'.
 *   Every draw method picks dark/light colours via that flag.
 */

'use strict';

// Change51: legend geometry, shared by _updateViewport() (to centre the pendulum in the
// free space right of the legend) and _drawLegend(). One column = key KW 52 + value VW 100 + 2·PAD 7 + 2 border.
const LEGEND_X       = 12;  //Ch51-Add: left edge of the legend box (px)
const LEGEND_COL_W   = 168; //Ch51-Add: width of one legend column (px)
const LEGEND_FALL_PAD = 20; //Ch51-Add: px kept between a horizontal rod and the right canvas edge

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    // Bob trail — array of {x,y} canvas-pixel positions
    this.trail    = [];
    this.maxTrail = 120;

    // Y-offset for base-frame rendering (0 = normal, state.y_base = FREE mode)
    this._yOffset = 0;

    // Force-vector overlay toggle (set by app.js)
    this.showForces = false;

    // Viewport (recalculated each frame)
    this.scale   = 1000;
    this.originX = 0;
    this.originY = 0;
  }

  // ── Viewport ─────────────────────────────────────────────────────────────

  _updateViewport(L_rod, L_arm, earth_mode) {
    const W = this.canvas.width;
    const H = this.canvas.height;

    // The crank arm is ALWAYS drawn
    // "chopped" (the engineering-break visual) — L_arm never influences scale or layout at all, only
    // its own break-mark drawing in _drawConnectingArm. This guarantees the ROD always fits on
    // screen, at any length up to the 1m slider max, even if that makes the whole image small: the
    // scale is fitted to the space actually available above the fixed `pivotY` line (35% down from
    // the top), which is where the rod lives — far less than the full canvas height.
    this.armBreak = true;
    this.pivotY   = H * 0.35;   // fixed — upper region: pivot/rod/bob

    const TOP_MARGIN_FRAC = 0.06;  // room for the theta/t text overlay
    const ROD_FIT_FRACTION = 0.92; // leave ~8% margin above the upright bob
    const availableAbovePivot = this.pivotY - H * TOP_MARGIN_FRAC;
    const fitCapScale = (availableAbovePivot * ROD_FIT_FRACTION) / Math.max(L_rod, 1e-6);

    // Below a certain rod length, fitCapScale would zoom in absurdly far
    // (tiny L_rod -> huge scale) — fixedScale keeps short/typical rods at
    // the same familiar zoom level (calibrated so a 0.16m rod renders at a
    // reasonable size); take whichever is smaller so long rods always
    // shrink to fit.
    const REFERENCE_L_ROD = 0.16;
    const fixedScale = (H * 0.30) / REFERENCE_L_ROD;
    this.scale   = Math.min(fixedScale, fitCapScale);
    // Change51: with the legend in two columns on the left, centre the pendulum in the
    // free space to its right — but only if a rod fallen to the right (horizontal) still fits on the canvas.
    // Otherwise (narrow canvas) keep the pendulum at the canvas centre; the legend stays in two columns either way
    // , so on a narrow canvas a fall to the left passes behind the legend box.
    const legendRight2 = LEGEND_X + 2 * LEGEND_COL_W;            //Ch51-Add: right edge of a two-column legend
    const shiftedX     = (legendRight2 + W) / 2;                 //Ch51-Add: centre of the free space right of it
    const shiftFits    = (W - shiftedX) >= L_rod * this.scale + LEGEND_FALL_PAD; //Ch51-Add
    this.legendTwoCol  = true; //Ch51-Add: read by _drawLegend(); always two columns (one-column code kept for a possible later switch)
    // Change51b: on a narrow canvas push the pendulum as far right as a fall to the right
    // still allows (was: canvas centre, which left the upright rod behind the two-column legend); never left of centre.
    const rightmostX   = W - L_rod * this.scale - LEGEND_FALL_PAD; //Ch51b-Add
    this.originX = shiftFits ? Math.max(W / 2, shiftedX) : Math.max(W / 2, rightmostX); //Ch51-Edt: was always W / 2 //Ch51b-Edt: narrow case was W / 2
    this.earthY  = H - 28;

    // Place the wheel so the base bottom sits just above the earth/void line.
    const baseBottomPx = 0.105 * this.scale;
    const MIN_SPRING   = 35;   // px — minimum spring/void gap below base
    this.originY = earth_mode
      ? Math.min(H * 0.67, this.earthY - baseBottomPx - MIN_SPRING)
      : H * 0.67;
  }

  /** Physics coords (y-up, metres) → canvas coords (y-down, px) */
  toCanvas(px, py) {
    return {
      x: this.originX + px * this.scale,
      y: this.originY - (py - this._yOffset) * this.scale,
    };
  }

  /**
   * Maps physics coords to canvas, but places the pivot at this.pivotY when
   * armBreak is active.  Use for all elements in the upper region (pivot, rod,
   * bob, angle arc, force arrows, trail).
   */
  toCanvasFromPivot(px, py, state) {
    if (this.armBreak) {
      const relY = py - state.y_pivot;   // positive = above pivot (physics y-up)
      return {
        x: this.originX + px * this.scale,
        y: this.pivotY  - relY * this.scale,
      };
    }
    return this.toCanvas(px, py);
  }

  // ── Theme helper ──────────────────────────────────────────────────────────

  _isLight() {
    return document.documentElement.dataset.theme === 'light';
  }

  // ── Main render ───────────────────────────────────────────────────────────

  render(state, params) {
    // In FREE mode render in base frame so the apparatus stays centred on screen.
    this._yOffset = !params.earth_mode ? state.y_base : 0;
    this._updateViewport(params.L_rod, params.L_arm, params.earth_mode);

    // Canvas has no size when hidden (e.g. GRAPHS mode) — nothing to draw.
    if (this.scale <= 0) return;

    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // In EARTH mode, clamp y_base so the chassis never renders below the earth
    // line — physics is unclamped, this is display-only.
    // Chassis bottom sits 0.105 m below y_base; keep it at or above earthY.
    const chassisBottomOff = 0.105;
    const y_base_floor = params.earth_mode
      ? (this.originY - this.earthY) / this.scale + chassisBottomOff
      : -Infinity;
    const visState = (params.earth_mode && state.y_base < y_base_floor)
      ? { ...state, y_base: y_base_floor }
      : state;

    this._drawBackground(W, H);
    this._drawScanlines(W, H);
    if (!params.earth_mode) {
      this._drawVoid(W);
    } else {
      this._drawGround(W);
    }
    this._drawBase(visState);
    this._drawMountingShaft(visState);
    this._drawWheel(visState, params);
    if (params.earth_mode && !params.rigid_base) {
      this._drawSpring(visState);
    }
    this._drawCylinderGuide(visState);
    this._drawConnectingArm(visState, params);
    this._drawPivot(state);
    this._updateTrail(state);
    this._drawTrail();
    this._drawRod(state);
    this._drawBob(state);
    this._drawForces(visState, params);
    this._drawAngleArc(state);
    this._drawLabels(visState, params);
    this._drawAnnotations(state, params);
    this._drawLegend(state, params);
  }

  // ── Background ────────────────────────────────────────────────────────────

  _drawBackground(W, H) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const grad  = ctx.createRadialGradient(
      W * 0.5, H * 0.38, 0,
      W * 0.5, H * 0.5,  Math.max(W, H) * 0.75
    );
    if (light) {
      grad.addColorStop(0, '#f2ead8');
      grad.addColorStop(1, '#eae3cd');
    } else {
      grad.addColorStop(0, '#0d1825');
      grad.addColorStop(1, '#060a10');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  _drawScanlines(W, H) {
    if (this._isLight()) return;   // scanlines look wrong on a light background
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.055)';
    for (let y = 0; y < H; y += 3) {
      ctx.fillRect(0, y, W, 1);
    }
  }

  // ── Void (free-float mode) ────────────────────────────────────────────────

  _drawVoid(W) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const gy    = this.earthY;
    const H     = this.canvas.height;
    const barH  = H - gy;

    ctx.fillStyle = light ? 'rgba(220, 210, 195, 0.3)' : 'rgba(10, 18, 30, 0.4)';
    ctx.fillRect(0, gy, W, barH);

    ctx.save();
    ctx.strokeStyle = light ? 'rgba(100, 90, 70, 0.30)' : 'rgba(40, 80, 120, 0.40)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font          = 'bold 10px "Courier New", monospace';
    ctx.letterSpacing = '0.14em';
    ctx.fillStyle     = light ? 'rgba(80, 70, 55, 0.35)' : 'rgba(60, 100, 150, 0.40)';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.fillText('F R E E   F L O A T', W / 2, gy + barH / 2);
    ctx.restore();
  }

  // ── Earth ─────────────────────────────────────────────────────────────────

  _drawGround(W) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const gy    = this.earthY;
    const barH  = this.canvas.height - gy;

    const grad = ctx.createLinearGradient(0, gy, 0, gy + barH);
    if (light) {
      grad.addColorStop(0, '#c0b8a8');
      grad.addColorStop(1, '#b0a898');
    } else {
      grad.addColorStop(0, '#1a2d3e');
      grad.addColorStop(1, '#0c1820');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, gy, W, barH);

    // Top border line
    ctx.strokeStyle = light ? '#8a7f6f' : '#4a7090';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();

    // Dense diagonal hatching
    ctx.save();
    ctx.strokeStyle = light ? 'rgba(100, 90, 70, 0.35)' : 'rgba(55, 95, 130, 0.55)';
    ctx.lineWidth   = 1.2;
    for (let x = -barH; x < W + barH; x += 13) {
      ctx.beginPath();
      ctx.moveTo(x,        gy + 1);
      ctx.lineTo(x + barH, gy + barH + 1);
      ctx.stroke();
    }
    ctx.restore();

    // "EARTH" label
    ctx.save();
    ctx.font          = 'bold 10px "Courier New", monospace';
    ctx.letterSpacing = '0.14em';
    ctx.fillStyle     = light ? 'rgba(80, 70, 55, 0.6)' : 'rgba(100, 155, 195, 0.65)';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.fillText('E A R T H', W / 2, gy + barH / 2);
    ctx.restore();

    // "rigid support" annotation
    ctx.save();
    ctx.font          = '9px Trebuchet MS, Tahoma, sans-serif';
    ctx.fillStyle     = light ? 'rgba(80, 70, 55, 0.45)' : 'rgba(70, 110, 150, 0.5)';
    ctx.textAlign     = 'right';
    ctx.textBaseline  = 'middle';
    ctx.fillText('rigid support', W - 10, gy + barH / 2);
    ctx.restore();
  }

  // ── Spring ────────────────────────────────────────────────────────────────

  _drawSpring(state) {
    const ctx         = this.ctx;
    const light       = this._isLight();
    const baseBottomY = state.y_base - 0.070 - 0.035;  // matches chassis bottom

    const { x: cx, y: topY } = this.toCanvas(0, baseBottomY);
    const bottomY = this.earthY;

    const totalH  = bottomY - topY;
    const zigzags = 7;
    const segH    = totalH / (zigzags * 2 + 2);
    const zigW    = 9;

    ctx.save();
    ctx.strokeStyle = light ? '#b8700a' : '#d97706';
    ctx.lineWidth   = 1.8;
    ctx.shadowColor = light ? 'rgba(184, 112, 10, 0.35)' : 'rgba(217, 119, 6, 0.45)';
    ctx.shadowBlur  = 5;
    ctx.beginPath();
    ctx.moveTo(cx, bottomY);
    ctx.lineTo(cx, bottomY - segH);

    for (let i = 0; i < zigzags; i++) {
      const yMid  = bottomY - segH * (i * 2 + 2);
      const yNext = bottomY - segH * (i * 2 + 3);
      ctx.lineTo(cx + (i % 2 === 0 ? zigW : -zigW), yMid);
      ctx.lineTo(cx, yNext);
    }

    ctx.lineTo(cx, topY);
    ctx.stroke();

    // Horizontal attachment cap where spring meets the base platform
    const capW = 16;
    ctx.lineWidth  = 3.5;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx - capW, topY);
    ctx.lineTo(cx + capW, topY);
    ctx.stroke();

    ctx.restore();
  }

  // ── Base platform ─────────────────────────────────────────────────────────

  _drawBase(state) {
    const ctx    = this.ctx;
    const light  = this._isLight();
    const halfW  = 0.085;  // chassis width
    const height = 0.035;  // chassis height
    const topOff = 0.070;  // base top sits 70 mm below wheel centre — below wheel rim

    const { x: lx, y: ty } = this.toCanvas(-halfW, state.y_base - topOff);
    const { x: rx, y: by } = this.toCanvas( halfW,  state.y_base - topOff - height);
    const w = rx - lx;
    const h = by - ty;

    ctx.save();

    // Main chassis body
    const grad = ctx.createLinearGradient(lx, ty, lx, by);
    if (light) {
      grad.addColorStop(0,    '#d0c8b8');
      grad.addColorStop(0.12, '#c4bca8');
      grad.addColorStop(1,    '#a8a090');
    } else {
      grad.addColorStop(0,    '#1e3048');
      grad.addColorStop(0.12, '#182840');
      grad.addColorStop(1,    '#0c1828');
    }
    ctx.fillStyle   = grad;
    ctx.strokeStyle = light ? '#9a9080' : '#2d4d6a';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(lx, ty, w, h, 5);
    ctx.fill();
    ctx.stroke();

    // Top surface highlight strip
    ctx.fillStyle = light ? 'rgba(245, 235, 220, 0.45)' : 'rgba(80, 140, 190, 0.18)';
    ctx.beginPath();
    ctx.roundRect(lx, ty, w, 5, [5, 5, 0, 0]);
    ctx.fill();

    // Shaft hole indicator on top surface
    const wc     = this.toCanvas(0, state.y_base);
    const holeR  = 7;
    ctx.strokeStyle = light ? '#8a8070' : '#3a607a';
    ctx.fillStyle   = light ? 'rgba(160, 152, 138, 0.8)' : 'rgba(10, 20, 36, 0.9)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(wc.x, ty, holeR, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  // ── Mounting shaft (pedestal between chassis top and wheel axle) ─────────

  _drawMountingShaft(state) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const wc              = this.toCanvas(0, state.y_base);
    const { y: baseTopY } = this.toCanvas(0, state.y_base - 0.070);

    const postW = 10;

    ctx.save();
    const grad = ctx.createLinearGradient(wc.x - postW / 2, 0, wc.x + postW / 2, 0);
    if (light) {
      grad.addColorStop(0,   '#a0988a');
      grad.addColorStop(0.5, '#c8c0b0');
      grad.addColorStop(1,   '#a0988a');
    } else {
      grad.addColorStop(0,   '#182840');
      grad.addColorStop(0.5, '#2e4668');
      grad.addColorStop(1,   '#182840');
    }
    ctx.fillStyle   = grad;
    ctx.strokeStyle = light ? '#8a8070' : '#2d4d6a';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.rect(wc.x - postW / 2, wc.y, postW, baseTopY - wc.y);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ── Oscillator wheel ──────────────────────────────────────────────────────

  _drawWheel(state, params) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const wc    = this.toCanvas(0, state.y_base);
    const visR  = params.r_osc * this.scale * 2.5;

    ctx.save();

    // Wheel body
    const grad = ctx.createRadialGradient(wc.x, wc.y, 0, wc.x, wc.y, visR);
    if (light) {
      grad.addColorStop(0.0, '#d4ccbc');
      grad.addColorStop(1.0, '#c4bcac');
    } else {
      grad.addColorStop(0.0, '#1a2d44');
      grad.addColorStop(1.0, '#0c1826');
    }
    ctx.fillStyle   = grad;
    ctx.strokeStyle = light ? '#8a8070' : '#2a4a68';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(wc.x, wc.y, visR, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    // Spokes
    ctx.strokeStyle = light ? '#a8a090' : '#1d3555';
    ctx.lineWidth   = 1.5;
    for (let i = 0; i < 6; i++) {
      const a = state.theta_osc + i * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(wc.x, wc.y);
      ctx.lineTo(wc.x + visR * 0.82 * Math.sin(a), wc.y - visR * 0.82 * Math.cos(a));
      ctx.stroke();
    }

    // Rim tick marks
    ctx.strokeStyle = light ? '#8a8070' : '#3a607a';
    ctx.lineWidth   = 2;
    for (let i = 0; i < 12; i++) {
      const a = state.theta_osc + i * Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(wc.x + visR * 0.87 * Math.sin(a), wc.y - visR * 0.87 * Math.cos(a));
      ctx.lineTo(wc.x + visR         * Math.sin(a), wc.y - visR         * Math.cos(a));
      ctx.stroke();
    }

    // Centre hub
    ctx.fillStyle   = light ? '#6a8098' : '#4a7898';
    ctx.strokeStyle = light ? '#7a90a8' : '#5a90b5';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(wc.x, wc.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // Crank pin — placed at the visual wheel surface
    const cp = {
      x: wc.x + visR * Math.sin(state.theta_osc),
      y: wc.y - visR * Math.cos(state.theta_osc),
    };
    ctx.save();
    ctx.shadowColor = light ? 'rgba(20, 100, 170, 0.5)' : 'rgba(120, 190, 230, 0.5)';
    ctx.shadowBlur  = 6;
    ctx.fillStyle   = light ? '#1a70b0' : '#78c0e8';
    ctx.strokeStyle = light ? '#2a80c0' : '#a0d8f8';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ── Cylinder guide ────────────────────────────────────────────────────────

  _drawCylinderGuide(state) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const guideColor = light ? 'rgba(100, 90, 70, 0.4)' : 'rgba(40, 70, 110, 0.55)';
    const boxColor   = light ? 'rgba(110, 100, 80, 0.3)' : 'rgba(50, 90, 130, 0.4)';
    const cw = 6;

    ctx.save();
    ctx.strokeStyle = guideColor;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 5]);

    if (this.armBreak) {
      // Split layout: draw a short guide stub only in the upper (pivot) region.
      const pivotTop  = this.toCanvasFromPivot(0, state.y_pivot + 0.005, state);
      const pivotBase = this.toCanvasFromPivot(0, state.y_pivot - 0.06,  state);
      ctx.beginPath();
      ctx.moveTo(this.originX, pivotBase.y);
      ctx.lineTo(this.originX, pivotTop.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = boxColor;
      ctx.strokeRect(this.originX - cw, pivotBase.y, cw * 2, pivotTop.y - pivotBase.y);
    } else {
      const top  = this.toCanvas(0, state.y_pivot + 0.005);
      const base = this.toCanvas(0, state.y_base   + 0.002);
      ctx.beginPath();
      ctx.moveTo(this.originX, base.y);
      ctx.lineTo(this.originX, top.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = boxColor;
      ctx.strokeRect(this.originX - cw, base.y, cw * 2, top.y - base.y);
    }

    ctx.restore();
  }

  // ── Connecting arm (crank pin → pivot) ───────────────────────────────────

  _drawConnectingArm(state, params) {
    const ctx      = this.ctx;
    const light    = this._isLight();
    const armColor = light ? '#5a7080' : '#3a6088';
    const wc       = this.toCanvas(0, state.y_base);
    const visR     = params.r_osc * this.scale * 2.5;
    const from = {
      x: wc.x + visR * Math.sin(state.theta_osc),
      y: wc.y - visR * Math.cos(state.theta_osc),
    };
    const to = this.toCanvas(0, state.y_pivot);

    ctx.save();
    ctx.strokeStyle = armColor;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';

    if (!this.armBreak) {
      // Normal case — pivot is on canvas, draw the full arm
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x,   to.y);
      ctx.stroke();
    } else {
      // Split-viewport mode: break the arm between the wheel and pivot regions.
      // The break zone is anchored just above the lowest possible crank-pin
      // position so the bottom arm segment is always a visible length.
      const BREAK_BOT = this.originY - visR - 30;  // 30 px above lowest crank pin
      const BREAK_TOP = BREAK_BOT - 40;             // 40 px break gap
      const BREAK_MID = (BREAK_BOT + BREAK_TOP) / 2;

      // x-coord along the actual arm direction at a given canvas-y
      // (arm is nearly vertical; this handles any slight tilt from the crank)
      const xAt = (cy) => from.x + ((cy - from.y) / (to.y - from.y)) * (to.x - from.x);

      // Arm direction unit vector (toward actual off-screen pivot, i.e. upward)
      const dx = to.x - from.x, dy = to.y - from.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / d, uy = dy / d;   // uy < 0 (upward in canvas)
      const hx = -uy, hy = ux;          // perpendicular ≈ (1, 0) for near-vertical arm

      // ── Lower segment: crank pin → break zone ─────────────────────────
      ctx.beginPath();
      ctx.moveTo(from.x,         from.y);
      ctx.lineTo(xAt(BREAK_BOT), BREAK_BOT);
      ctx.stroke();

      // ── Upper stub: break zone → visual pivot ──────────────────────────
      // Pivot is always at x=0 (physics) → canvas originX
      ctx.beginPath();
      ctx.moveTo(this.originX, BREAK_TOP);
      ctx.lineTo(this.originX, this.pivotY);
      ctx.stroke();

      // ── Break mark: two diagonal slashes + dotted gap ─────────────────
      const x_mid = xAt(BREAK_MID);
      const HALF = 8, STEP = 8;
      ctx.lineWidth = 2;
      // Slash 1 (lower)
      ctx.beginPath();
      ctx.moveTo(x_mid - STEP*ux - HALF*hx, BREAK_MID - STEP*uy - HALF*hy);
      ctx.lineTo(x_mid - STEP*ux + HALF*hx, BREAK_MID - STEP*uy + HALF*hy);
      ctx.stroke();
      // Slash 2 (upper)
      ctx.beginPath();
      ctx.moveTo(x_mid + STEP*ux - HALF*hx, BREAK_MID + STEP*uy - HALF*hy);
      ctx.lineTo(x_mid + STEP*ux + HALF*hx, BREAK_MID + STEP*uy + HALF*hy);
      ctx.stroke();
      // Dotted gap between the slashes
      ctx.save();
      ctx.lineWidth = 1.5; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x_mid - STEP*ux, BREAK_MID - STEP*uy);
      ctx.lineTo(x_mid + STEP*ux, BREAK_MID + STEP*uy);
      ctx.stroke();
      ctx.setLineDash([]); ctx.restore();

      // Label showing the true arm length
      if (params.L_arm) {
        ctx.save();
        ctx.font         = '12px "Courier New", monospace';
        ctx.fillStyle    = light ? 'rgba(60, 90, 110, 0.65)' : 'rgba(90, 150, 185, 0.65)';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('L_arm=' + params.L_arm.toFixed(2) + 'm', x_mid + HALF + 5, BREAK_MID); //Ch40-Edt: was 'L=' — requested: 'L' (bare) is associated with the rod (L_rod) elsewhere, so this crank-arm label now reads 'L_arm=' to avoid confusion
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // ── Pivot point ───────────────────────────────────────────────────────────

  _drawPivot(state) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const pivot = this.toCanvasFromPivot(0, state.y_pivot, state);

    ctx.save();
    ctx.shadowColor = light ? 'rgba(0, 100, 170, 0.55)' : 'rgba(0, 212, 255, 0.55)';
    ctx.shadowBlur  = 10;
    ctx.strokeStyle = light ? '#0077aa' : '#00d4ff';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 5.5, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = light ? '#005588' : '#00a8cc';
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 2.8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // ── Bob trail ─────────────────────────────────────────────────────────────

  _updateTrail(state) {
    const pt = this.toCanvasFromPivot(state.x_bob, state.y_bob, state);
    this.trail.push({ x: pt.x, y: pt.y });
    if (this.trail.length > this.maxTrail) this.trail.shift();
  }

  _drawTrail() {
    if (this.trail.length < 2) return;
    const ctx   = this.ctx;
    const light = this._isLight();
    ctx.save();
    for (let i = 1; i < this.trail.length; i++) {
      const frac  = i / this.trail.length;
      const alpha = frac * frac * 0.28;
      ctx.strokeStyle = light
        ? `rgba(0, 100, 170, ${alpha})`
        : `rgba(0, 212, 255, ${alpha})`;
      ctx.lineWidth   = frac * 1.8;
      ctx.beginPath();
      ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
      ctx.lineTo(this.trail[i].x,     this.trail[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Pendulum rod ──────────────────────────────────────────────────────────

  _drawRod(state) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const pivot = this.toCanvasFromPivot(0, state.y_pivot, state);
    const bob   = this.toCanvasFromPivot(state.x_bob, state.y_bob, state);
    // The rod is always this colour;
    // the bob (_drawBob below) smoothly reddens with angle.

    ctx.save();
    ctx.strokeStyle = light ? 'rgba(30,  50,  80,  0.92)' : 'rgba(210, 230, 255, 0.92)';
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';
    ctx.shadowColor = light ? 'rgba(30,  60,  100, 0.3)'  : 'rgba(180, 210, 255, 0.3)';
    ctx.shadowBlur  = 5;
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(bob.x,   bob.y);
    ctx.stroke();
    ctx.restore();
  }

  // ── Bob ───────────────────────────────────────────────────────────────────

  _drawBob(state) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const bob   = this.toCanvasFromPivot(state.x_bob, state.y_bob, state);
    const angle = Math.abs(state.angle_rod);
    const t     = Math.min(angle / (Math.PI / 3), 1);

    // The hue interpolates continuously
    // with angle: it reaches its reddest point (t=1) at 60 deg and holds there.
    const hue  = Math.round(190 - t * 155);
    const lum  = light ? '50%' : '65%';
    const glum = light ? '40%' : '50%';
    const color = `hsl(${hue}, 100%, ${lum})`;
    const glow  = `hsla(${hue}, 100%, ${glum}, 0.45)`;

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur  = t < 0.2 ? 22 : 10;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(bob.x, bob.y, 10, 0, 2 * Math.PI);
    ctx.fill();

    // Specular highlight
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = 'rgba(255, 255, 255, 0.32)';
    ctx.beginPath();
    ctx.arc(bob.x - 3, bob.y - 3, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // ── Force vector overlay ──────────────────────────────────────────────────

  /**
   * Draw a single force arrow in canvas space.
   * @param {number} fromX  Canvas x of arrow origin
   * @param {number} fromY  Canvas y of arrow origin
   * @param {number} Fx     Force x-component (physics coords, N)
   * @param {number} Fy     Force y-component (physics coords, N, y-up)
   * @param {number} pxPerN Pixels per Newton (linear scale)
   * @param {number} maxPx  Maximum arrow length in pixels
   * @param {string} color  CSS colour
   * @param {string} label  Short label placed at the arrowhead
   * @param {number} [minPx=0]  Minimum drawn length so tiny forces stay visible
   */
  // fixedLabel: when true, draws the label at a fixed offset from the origin
  // rather than at the (oscillating) tip — prevents label jitter on forces
  // whose magnitude or direction varies rapidly.
  _drawForceArrow(fromX, fromY, Fx, Fy, pxPerN, maxPx, color, label, minPx = 0, fixedLabel = false, strokeWidth = 1.5) {
    const mag = Math.sqrt(Fx * Fx + Fy * Fy);
    if (mag < 0.001) return;

    const pxLen = Math.max(minPx, Math.min(mag * pxPerN, maxPx));
    // Canvas y is downward, so flip the y component
    const toX = fromX + (Fx / mag) * pxLen;
    const toY = fromY - (Fy / mag) * pxLen;

    const dx  = toX - fromX;
    const dy  = toY - fromY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = strokeWidth;
    ctx.lineCap     = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur  = 3;

    // Shaft
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX,   toY);
    ctx.stroke();

    // Arrowhead
    const angle   = Math.atan2(dy, dx);
    const headLen = Math.min(7, len * 0.35);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - 0.45), toY - headLen * Math.sin(angle - 0.45));
    ctx.lineTo(toX - headLen * Math.cos(angle + 0.45), toY - headLen * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();

    // Label: fixed position (next to origin) or at tip
    const magStr  = mag >= 10 ? mag.toFixed(0) : mag.toFixed(1);
    const fullLbl = `${label} ${magStr}N`;
    ctx.shadowBlur   = 6;
    ctx.font         = 'bold 12px "Courier New", monospace';
    ctx.textBaseline = 'middle';
    if (fixedLabel) {
      ctx.textAlign = 'left';
      ctx.fillText(fullLbl, fromX + 8, fromY);
    } else {
      ctx.textAlign = dx >= 0 ? 'left' : 'right';
      ctx.fillText(fullLbl, toX + (dx >= 0 ? 6 : -6), toY);
    }

    ctx.restore();
  }

  /**
   * Draw all force vectors when showForces is true.
   * Forces on the bob use a scale where gravity (mass_bob·g) → 20 px so even
   * the small gravity stub is visible.  The same scale makes the much-larger
   * inertial rod force (T ≈ 16 N peak) visibly dominant — that disparity IS
   * the Kapitza mechanism.  Forces on the base use an independent 2 px/N scale.
   */
  _drawForces(state, params) {
    if (!this.showForces) return;
    const p = params;

    // Use nominal (rest) positions so arrows don't jitter with oscillation.
    // In armBreak mode (typical): pivotY is a fixed canvas coordinate; the
    // upright bob sits exactly L_rod above it — state-independent.
    const bobC = this.armBreak
      ? { x: this.originX, y: this.pivotY - p.L_rod * this.scale }
      : this.toCanvas(0, p.L_rod);
    const pivotC = this.toCanvasFromPivot(0, state.y_pivot, state);

    // Bob-force scale: gravity (mass_bob·g) → 20 px; cap at 38 px
    const F_grav   = p.mass_bob * p.g;
    const bobScale = 20 / F_grav;
    const bobMax   = 38;

    // Base/pivot force scale: 6 px/N; cap at 140 px
    const baseScale = 6;
    const baseMax   = 140;

    // ── Forces on the bob ──────────────────────────────────────────────────

    // Gravity — 10 px left of bob centre so it doesn't overlap T.
    this._drawForceArrow(bobC.x - 10, bobC.y,
      0, -F_grav, bobScale, bobMax, '#ff6666', 'mg');

    // Rod force T — 10 px right of bob centre.
    // Always drawn along the rod TOWARD the pivot (downward for an inverted
    // pendulum) so the arrow never exits the top of the canvas.
    //   Cyan = force is toward  the pivot (rod pulling bob down — tension).
    //   Pink = force is away from pivot   (rod pushing bob up — compression,
    //          the dominant case when the pivot jerks upward rapidly).
    const Tx = state.F_rod_on_bob_x || 0;
    const Ty = state.F_rod_on_bob_y || 0;
    const T_mag = Math.sqrt(Tx * Tx + Ty * Ty);
    if (T_mag > 0.001) {
      // Colour encodes tension (cyan) vs compression (pink): dot product of
      // actual force with the toward-pivot unit vector.
      const toPivX  = -state.x_bob;
      const toPivY  = state.y_pivot - state.y_bob;
      const rodDist = Math.sqrt(toPivX * toPivX + toPivY * toPivY) || 1e-9;
      const color = (Tx * toPivX + Ty * toPivY) >= 0 ? '#00d4ff' : '#ff88cc';
      // Direction is always straight down (toward pivot for inverted pendulum)
      // so the arrow stays in-frame and the label doesn't oscillate.
      this._drawForceArrow(bobC.x + 10, bobC.y,
        0, -T_mag, bobScale, bobMax, color, 'T', 0, true);
    }

    // ── Forces on the base ─────────────────────────────────────────────────

    // Rod reaction on base (amber) — at the pivot point.
    // At rest F↕ ≈ −mass_bob·g ≈ −0.49 N (bob's weight transmitted through rod);
    // grows to ~16 N peak once oscillating.  minPx=5 keeps the stub visible at rest.
    this._drawForceArrow(pivotC.x, pivotC.y,
      0, state.F_rod_on_base || 0, baseScale, baseMax, '#f59e0b', 'F↕', 5, true);

    // Spring restoring force (bright green) — EARTH mode only; offset right.
    // 5 px minimum stub keeps it visible even when spring barely deflects.
    // (None in CLASSICAL mode — there is no spring on a rigid base.)
    if (p.earth_mode && !p.rigid_base) {
      // Anchor at spring midpoint (−0.130 m), clear of chassis (bottom at −0.105 m).
      // Spring forces are small when base is heavy, so use a larger dedicated scale.
      const baseC = this.toCanvas(0.035, -0.130);
      this._drawForceArrow(baseC.x, baseC.y,
        0, state.F_spring_y || 0, 20, 80, '#4ade80', 'k·x', 8, true);
    }
  }

  // ── Angle indicator arc ───────────────────────────────────────────────────

  _drawAngleArc(state) {
    if (Math.abs(state.angle_rod) < 0.008) return;
    const ctx   = this.ctx;
    const light = this._isLight();
    const pivot = this.toCanvasFromPivot(0, state.y_pivot, state);
    const r     = 34;

    ctx.save();

    // Vertical reference (dashed)
    ctx.strokeStyle = light ? 'rgba(0, 100, 170, 0.2)' : 'rgba(0, 212, 255, 0.18)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y - r - 8);
    ctx.lineTo(pivot.x, pivot.y + 5);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arc
    ctx.strokeStyle = light ? 'rgba(0, 100, 170, 0.6)' : 'rgba(0, 212, 255, 0.5)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    const a = state.angle_rod;
    ctx.arc(pivot.x, pivot.y, r, -Math.PI / 2, -Math.PI / 2 + a, a < 0);
    ctx.stroke();
    ctx.restore();
  }

  // ── Text overlays ─────────────────────────────────────────────────────────

  _drawLabels(state, params) {
    const ctx      = this.ctx;
    const light    = this._isLight();
    // Explicit '+' for non-negative angles (font
    // is monospace, so '+'/'-' occupy the same width — digits don't
    // shift left/right as the sign flips).
    const angleDegNum = state.angle_rod * 180 / Math.PI;
    const angleDeg = (angleDegNum >= 0 ? '+' : '') + angleDegNum.toFixed(2);
    const timeSec  = state.t.toFixed(2);

    ctx.save();
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';

    // ── θ readout ────────────────────────────────────────────────────────────
    // Label
    ctx.font      = '12px "Courier New", monospace';
    ctx.fillStyle = light ? 'rgba(0, 80, 150, 0.55)' : 'rgba(0, 212, 255, 0.45)';
    ctx.fillText('rod angle', 12, 8);
    // Value
    ctx.font      = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = light ? 'rgba(0, 80, 150, 0.9)' : 'rgba(0, 212, 255, 0.85)';
    ctx.fillText(`θ = ${angleDeg}°`, 12, 23);

    // ── t readout ────────────────────────────────────────────────────────────
    // Label
    ctx.font      = '12px "Courier New", monospace';
    ctx.fillStyle = light ? 'rgba(40, 60, 80, 0.5)' : 'rgba(140, 175, 205, 0.45)';
    ctx.fillText('elapsed time', 12, 44);
    // Value
    ctx.font      = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = light ? 'rgba(40, 60, 80, 0.75)' : 'rgba(140, 175, 205, 0.75)';
    ctx.fillText(`t = ${timeSec} s`, 12, 59);

    // No in-canvas status text — the sidebar
    // status badge already covers stopped/target_reached messaging.
    if (!params.earth_mode || params.rigid_base) {
      ctx.font         = '10px "Courier New", monospace';
      ctx.fillStyle    = light ? 'rgba(0, 100, 170, 0.55)' : 'rgba(80, 160, 220, 0.55)';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(!params.earth_mode ? 'FREE FLOAT' : 'RIGID BASE', this.canvas.width - 12, 10);
    }
    ctx.restore();
  }

  _drawAnnotations(state, params) {
    const ctx   = this.ctx;
    const light = this._isLight();
    ctx.save();
    ctx.font      = '9.5px Trebuchet MS, Tahoma, sans-serif';
    ctx.fillStyle = light ? 'rgba(60, 80, 100, 0.5)' : 'rgba(80, 120, 160, 0.45)';
    ctx.textAlign = 'left';

    const W = this.canvas.width;

    const bob = this.toCanvasFromPivot(state.x_bob, state.y_bob, state);
    ctx.fillText('BOB', bob.x + 14, bob.y + 4);

    const pivot = this.toCanvasFromPivot(0, state.y_pivot, state);
    ctx.fillText('PIVOT', pivot.x + 10, pivot.y - 8);

    const wc = this.toCanvas(0, state.y_base);
    ctx.fillText('WHEEL', wc.x + params.r_osc * this.scale * 2.8, wc.y + 4);

    // BASE label — right side of chassis (shown in both modes)
    const chassisCenterY = this.toCanvas(0, state.y_base - 0.070 - 0.0175).y;
    ctx.textAlign = 'left';
    ctx.fillText('BASE', this.toCanvas(0.085 + 0.012, 0).x, chassisCenterY);

    if (params.earth_mode && !params.rigid_base) {

      // SPRING label — right of the spring zigzag
      ctx.textAlign  = 'left';
      const baseBottomCanvas = this.toCanvas(0, state.y_base - 0.075).y;
      const springMidY = (baseBottomCanvas + this.earthY) / 2;
      ctx.fillText('SPRING', this.originX + 16, springMidY);
    }

    ctx.restore();
  }

  // ── Constants legend ──────────────────────────────────────────────────────

  _drawLegend(state, params) {
    const ctx   = this.ctx;
    const light = this._isLight();
    const W     = this.canvas.width;
    const p     = params;

    // Change55: was whole g / 0.1 kg / whole kg by size — now 6
    // significant digits so the exact log-slider value is shown (e.g. 50.1187 kg, not 50 kg).
    const massFmt = (kg) => kg < 1
      ? (kg * 1000).toPrecision(6) + ' g'   //Ch55-Edt
      : kg.toPrecision(6) + ' kg';          //Ch55-Edt

    // Swing extremum tracking value formatters.
    // sMax/sMin/sTot use 5 decimals
    // so slow shrink/growth is visible by eye across successive frames.
    // The three rate rows (sMax'/sMin'/lnTot') show N/A until the swing has
    // genuinely reached past +-1 deg on both sides — below that, a completed
    // swing's confirmed value is too close to the initial condition / noise
    // floor for a rate computed from it to be meaningful.
    const convergenceReady = state.swing_max_deg >= 1 && state.swing_min_deg <= -1;
    const signedDeg5 = (n) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(5) + '°';
    const signedRate = (n) => !convergenceReady || n == null ? 'N/A' : (n >= 0 ? '+' : '') + n.toFixed(3) + '°/s';
    const logRatePct = (n) => !convergenceReady || n == null ? 'N/A' : (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%/s';
    const signed2 = (n, unit) => n == null ? 'N/A' : (n >= 0 ? '+' : '') + n.toFixed(2) + unit; //Ch50-Add: base rows below
    const signed3 = (n, unit) => n == null ? 'N/A' : (n >= 0 ? '+' : '') + n.toFixed(3) + unit; //Ch50-Add

    const rows = [
      ['mode',    p.rigid_base ? 'CLASSIC' : (p.earth_mode ? 'EARTH' : 'FREE')],  // 
      ['f',       p.frequency_pivot.toFixed(3)           + ' Hz'   ], // 
      // Change54: A and L_rod were whole mm — now 2 decimals of mm;
      // a·ω and √2gL 3 -> 4 decimals; added f₀ and Dev = |f-f0|/f0.
      ['A',       (p.amplitude_pivot * 1000).toFixed(2)  + ' mm'   ], //Ch54-Edt: was toFixed(0)
      ['L_arm',   p.L_arm.toFixed(3)                     + ' m'    ],
      ['L_rod',   (p.L_rod * 1000).toFixed(2)            + ' mm'   ], //Ch54-Edt: was toFixed(0)
      ['m_bob',   massFmt(p.mass_bob)                              ],
      ['m_base',  p.rigid_base ? 'rigid (∞)' : massFmt(p.mass_base) ],
      ['θ₀',     (p.angle_rod_initial * 180 / Math.PI).toFixed(1) + '°'],  // 
      ['dt',      (p.dt * 1000).toFixed(3)                + ' ms'  ],
      // Change44: closed-form Kapitza stability prediction
      // (a*omega vs sqrt(2*g*L_rod), see physics.js _derive()) — shown so the actual run
      // outcome (falls or stays upright) can be checked against this formula at any L_rod.
      ['a·ω',     p.stab_drive_v.toFixed(4)               + ' m/s' ], //Ch54-Edt: was toFixed(3). //Ch45-Edt: was toFixed(2) — requested 3 decimals, 2 was rounding a·ω and √2gL to the same displayed value on close calls even though the FALL/STABLE verdict (computed from the full-precision values) correctly differed
      ['√2gL',    p.stab_threshold_v.toFixed(4)           + ' m/s' ], //Ch54-Edt: was toFixed(3). //Ch45-Edt: was toFixed(2) — see a·ω above
      ['f₀',      p.stab_threshold_f.toFixed(4)           + ' Hz'  ], //Ch54-Add: predicted threshold frequency
      ['Dev',     (p.stab_deviation * 100).toFixed(3)     + ' %'   ], //Ch54-Add: |f-f0|/f0
      ['pred',    p.stab_predicted_stable ? 'STABLE' : 'FALL'      ], //Ch44-Add: the verdict — compare against the actual run's final status; shortened key ('pred' not 'predict') to fit the KW=52px key column like the other rows
      // Change46: V_Hat_Sim (real crank-slider kinematics, see
      // physics.js _computeVHatSim()) vs ODEa_V_Hat_SineRef (idealized-sine closed form) —
      // avoided the "hat" accent in the key (garbles on screen), plain ASCII instead.
      ['Vsim',    p.V_Hat_Sim.toFixed(4)          + ' m2/s2'        ], //Ch46-Add: real crank kinematics, mean-square pivot velocity over one cycle
      ['Vsine',   p.ODEa_V_Hat_SineRef.toFixed(4)  + ' m2/s2'        ], //Ch46-Add: idealized-sine closed-form reference — see the mismatch check in _computeVHatSim()
    ];
    if (p.earth_mode && !p.rigid_base) {
      rows.push(
        ['k',   p.k_spring.toPrecision(6)         + ' N/m'], //Ch55-Edt: was Math.round
      );
    }
    // Swing extremum tracking: live max/min turning points of
    // angle_rod, their smoothed slopes, and the total-span log rate — see
    // physics.js _trackSwing()/_confirmSwingExtreme() and
    // project_swing_range_metric_design.md.
    // Change51: live readings go in their own list — the legend's right column when there
    // is room for two columns (see _updateViewport()), otherwise appended below the settings as before.
    const liveRows = [ //Ch51-Add
      // Change50: live base displacement, and its sliding 1 s average speed and
      // acceleration (physics.js step() section 8). g felt by the pendulum ≈ 9.8 + aB1s (aB1s < 0 = accelerating down).
      ['yBase',   p.rigid_base ? 'rigid' : signed2(state.y_base * 1000, ' mm')],      //Ch50-Add //Ch51-Edt: moved here from after m_base
      ['vB1s',    p.rigid_base ? 'rigid' : signed2(state.v_base_1s == null ? null : state.v_base_1s * 1000, ' mm/s')], //Ch50-Add: N/A until t ≥ 1 s //Ch51-Edt: moved
      ['aB1s',    p.rigid_base ? 'rigid' : signed3(state.a_base_1s, ' m/s²')],         //Ch50-Add: N/A until t ≥ 2 s //Ch51-Edt: moved
    ];
    liveRows.push( //Ch51-Edt: was rows.push(
      // Unconditional running max/min since t=0 (not swing/crossing-based —
      // a fall pushes these too).
      ['aMax',    signedDeg5(state.angle_max_deg)],
      ['aMin',    signedDeg5(state.angle_min_deg)],
      ['sMax',    signedDeg5(state.swing_max_deg)],
      ['sMin',    signedDeg5(state.swing_min_deg)],
      ["sMax'",   signedRate(state.swing_max_rate)],
      ["sMin'",   signedRate(state.swing_min_rate)],
      ['sTot',    signedDeg5(state.swing_angle_total_deg)],
      ['lnTot\'', logRatePct(state.swing_total_log_rate)],  // lnTot' — clarifies this is a log (relative) derivative, not a plain slope like sMax'/sMin'
    );
    // Change53b: time of the first sim-vs-ODEa mismatch and which check fired
    // (ang = angle trajectory, acc = acceleration, wAcc = wide acceleration). The checks only run in CLASSICAL mode
    // with a 1 m rod — otherwise 'not checked'.
    const odeKindShort = { angle: 'ang', accel: 'acc', wideAcc: 'wAcc' };   //Ch53b-Add: short names to fit the value column
    const odeMis = state.odeMismatchFirst;                                  //Ch53b-Add
    liveRows.push(['ODEmis', !state._odeaCompareActive() ? 'not checked'    //Ch53b-Add
      : (odeMis == null ? 'none' : odeMis.t.toFixed(2) + ' s ' + odeKindShort[odeMis.kind])]);

    const FS   = 11;
    const LH   = 16;
    const PAD  = 7;
    const KW   = 52;    // key column width
    const VW   = 100;   // value column width — wide enough for 5-decimal sMax/sMin/sTot
    const CW   = KW + VW + PAD * 2 + 2; //Ch51-Edt: was BW — width of ONE column (= LEGEND_COL_W)
    const cols = this.legendTwoCol ? [rows, liveRows] : [rows.concat(liveRows)]; //Ch51-Add: settings | live, or one column
    const BW   = CW * cols.length;      //Ch51-Edt: box width covers all columns
    const BH   = Math.max(...cols.map(c => c.length)) * LH + PAD * 2; //Ch51-Edt: was rows.length — the taller column sets the height

    // In split-viewport, anchor to upper-left (below the θ/t readout).
    // In normal mode, anchor to lower-right (above earth).
    const BX = this.armBreak ? LEGEND_X       : W - BW - 12; //Ch51-Edt: was 12
    const BY = this.armBreak ? 82             : this.earthY - BH - 10;

    ctx.save();
    ctx.fillStyle   = light ? 'rgba(238, 230, 215, 0.88)' : 'rgba(6, 14, 26, 0.86)';
    ctx.strokeStyle = light ? 'rgba(120, 108, 88, 0.38)'  : 'rgba(36, 70, 112, 0.60)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(BX, BY, BW, BH, 3);
    ctx.fill();
    ctx.stroke();

    ctx.font         = `${FS}px "Courier New", monospace`;
    ctx.textBaseline = 'top';
    cols.forEach((colRows, c) => { //Ch51-Add: one pass per column
      const CX = BX + c * CW;      //Ch51-Add: left edge of this column
      colRows.forEach(([key, val], i) => { //Ch51-Edt: was rows.forEach
        const ry = BY + PAD + i * LH;
        ctx.textAlign = 'left';
        ctx.fillStyle = light ? 'rgba(60, 88, 108, 0.75)' : 'rgba(100, 148, 190, 0.75)';
        ctx.fillText(key, CX + PAD, ry);      //Ch51-Edt: was BX + PAD
        ctx.textAlign = 'right';
        ctx.fillStyle = light ? 'rgba(25, 44, 64, 0.92)' : 'rgba(205, 222, 242, 0.92)';
        ctx.fillText(val, CX + CW - PAD, ry); //Ch51-Edt: was BX + BW - PAD
      });
    });

    ctx.restore();
  }
}
