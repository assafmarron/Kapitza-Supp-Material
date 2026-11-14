/**
 * charts.js — Real-time line charts with a fixed time axis
 *
 * Six canvas-based charts (zero external libraries):
 *   Chart 1 — Rod angle (degrees) vs time
 *   Chart 2 — Base displacement (mm) vs time
 *   Chart 3 — Pivot position (mm) vs time
 *   Chart 4 — Base & pivot velocity (m/s) vs time
 *   Chart 5 — Rod angle, sim vs ODEa (degrees) vs time (CLASSICAL mode only)
 *   Chart 6 — Angular acceleration, sim vs ODEa (rad/s²) vs time (CLASSICAL mode only)
 *
 * Each ScrollingChart:
 *   - Displays a fixed time window [0, windowSecs] — the axis never scrolls
 *   - Auto-scales the y-axis to the currently visible data
 *   - Draws grid lines, axis tick labels, and a zero reference line
 *   - Renders the trace with a two-pass phosphor-glow effect
 *
 * Theming:
 *   render() reads document.documentElement.dataset.theme at call time.
 *   Dark-mode line colours are mapped to richer light-mode equivalents.
 */

'use strict';

// ── Colour maps for light mode ──────────────────────────────────────────────
// Maps each dark-mode trace colour → its light-mode equivalent.
// Colours not in the map are used unchanged.
const LIGHT_COLOUR_MAP = {
  '#00d4ff': '#0077aa',   // cyan  → prussian blue
  '#f59e0b': '#b8700a',   // amber → dark amber
  '#a78bfa': '#6b46b5',   // violet → deep violet
};

// Changed OCT-31-2026 Change49: the left margin was a fixed 52px, so long y-tick labels (e.g. -151822.01 mm
// for a falling FREE-mode base) were drawn partly off the canvas and lost their leading digits .
// Returns the left margin needed for the widest y-tick label at the given y range: never less than the
// old 52px, so charts with short labels look exactly as before.
const Y_LABEL_PAD_MIN = 52; // Ch49-Add: px — the old fixed left margin, kept as the minimum
function yLabelPadLeft(ctx, yMin, yMax, yTicks) { // Ch49-Add
  ctx.font = '9px "Courier New", monospace'; // same font as the y-tick labels (Ch42)
  let widest = 0;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (i / yTicks) * (yMax - yMin);
    widest = Math.max(widest, ctx.measureText(v.toFixed(2)).width); // same text as the label drawn
  }
  return Math.max(Y_LABEL_PAD_MIN, Math.ceil(widest) + 12); // label is drawn ending 8px left of the plot; 4px spare at the canvas edge
}

// ── ScrollingChart ──────────────────────────────────────────────────────────

class ScrollingChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {string}  opts.label       Y-axis label text
   * @param {string}  opts.unit        Unit string appended after label
   * @param {string}  opts.lineColor   CSS colour for the data trace (dark-mode value)
   * @param {number}  opts.windowSecs  Width of the visible time window (s)
   * @param {number}  [opts.yPad=0.15] Fractional padding added above/below range
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.opts   = {
      label:      opts.label      ?? 'Value',
      unit:       opts.unit       ?? '',
      lineColor:  opts.lineColor  ?? '#00d4ff',
      windowSecs: opts.windowSecs ?? 6,
      yPad:       opts.yPad       ?? 0.15,
      scrolling:  true,
      // Change36a: optional per-chart overrides for the single-series
      // render() method's sharp pass (mirrors renderMulti()'s per-series lw/alpha from Change34) —
      // lets a single-trace chart (e.g. pivot position) be drawn wide/semi-transparent so its
      // own title text (drawn on top, same colour) stays legible instead of blending into the line.
      traceLw:    opts.traceLw    ?? 1.3, //Ch36a-Add: sharp-pass line width, defaults to the old hardcoded 1.3
      traceAlpha: opts.traceAlpha ?? 1.0, //Ch36a-Add: sharp-pass opacity, defaults to the old hardcoded 1.0
    };
  }

  /**
   * Render the chart with multiple overlaid traces sharing one y-axis.
   * @param {Array<{data: Array<{t:number,value:number}>, color: string, label: string}>} series
   * @param {number} tNow  Current simulation time (s)
   */
  renderMulti(series, tNow) {
    const ctx   = this.ctx;
    const W     = this.canvas.width;
    const H     = this.canvas.height;
    const light = document.documentElement.dataset.theme === 'light';

    const chartBg     = light ? '#faf6ef'                    : '#070d18';
    const gridColor   = light ? 'rgba(150, 130, 100, 0.50)' : 'rgba(50, 80, 115, 0.75)';
    const xGridColor  = light ? 'rgba(150, 130, 100, 0.40)' : 'rgba(50, 80, 115, 0.60)';
    const tickColor   = light ? 'rgba(100,  90,  70, 0.70)' : 'rgba(120, 170, 210, 0.70)';
    const labelColor  = light ? 'rgba( 40,  55,  70, 0.90)' : 'rgba(195, 225, 245, 0.92)';
    const xLblColor   = light ? 'rgba( 40,  55,  70, 0.85)' : 'rgba(185, 215, 240, 0.88)';
    const zeroColor   = light ? 'rgba(  0, 100, 170, 0.20)' : 'rgba(0, 212, 255, 0.15)';
    const borderColor = light ? 'rgba(130, 115,  95, 0.70)' : 'rgba(45, 75, 115, 0.80)';
    const colourOf    = c => light ? (LIGHT_COLOUR_MAP[c] ?? c) : c;

    const pad = { top: 20, right: 12, bottom: 28, left: 52 };
    let   pW  = W - pad.left - pad.right; // Ch49-Edt: was const — widened below once the y range (and so the label width) is known
    const pH  = H - pad.top  - pad.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = chartBg;
    ctx.fillRect(0, 0, W, H);

    const tMax = this.opts.scrolling ? tNow : this.opts.windowSecs;
    const tMin = this.opts.scrolling ? Math.max(0, tNow - this.opts.windowSecs) : 0;
    const visibleSeries = series.map(s => ({
      ...s,
      visible: s.data.filter(d => d.t >= tMin - 0.05 && d.t <= tMax + 0.05),
    }));

    let yMin, yMax;
    const allVals = visibleSeries.flatMap(s => s.visible.map(d => d.value));
    if (allVals.length === 0) {
      yMin = -1; yMax = 1;
    } else {
      let vMin = allVals[0], vMax = allVals[0];
      for (let i = 1; i < allVals.length; i++) {
        if (allVals[i] < vMin) vMin = allVals[i];
        if (allVals[i] > vMax) vMax = allVals[i];
      }
      let range  = vMax - vMin;
      if (range < 1e-6) range = 1;
      yMin = vMin - range * this.opts.yPad;
      yMax = vMax + range * this.opts.yPad;
    }
    if (yMin > 0 && yMin < (yMax - yMin) * 0.1) yMin = -(yMax - yMin) * 0.05;
    if (yMax < 0 && yMax > (yMax - yMin) * 0.1) yMax =  (yMax - yMin) * 0.05;

    pad.left = yLabelPadLeft(ctx, yMin, yMax, 4); // Ch49-Add: widen the left margin to fit the widest y-tick label (4 = yTicks below)
    pW       = W - pad.left - pad.right;          // Ch49-Add: plot width for the widened margin
    const xPx = t => pad.left + ((t - tMin) / this.opts.windowSecs) * pW;
    const yPx = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * pH;

    const yTicks = 4;
    ctx.font         = '9px "Courier New", monospace'; //Ch42-Edt: was '11px' — requested smaller y-axis tick font
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= yTicks; i++) {
      const v  = yMin + (i / yTicks) * (yMax - yMin);
      const py = yPx(v);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left,      py);
      ctx.lineTo(pad.left + pW, py);
      ctx.stroke();
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.left - 5, py);
      ctx.lineTo(pad.left,     py);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.fillText(v.toFixed(2), pad.left - 8, py); //Ch42-Edt: was v.toFixed(1) — requested 2 decimal places
    }

    // x-tick labels (time) — just 3: left edge, middle, right edge (a denser
    // grid overlapped/cluttered; intermediate values read by eye).
    ctx.font         = '11px "Courier New", monospace';
    ctx.textBaseline = 'top';
    [tMin, (tMin + tMax) / 2, tMax].forEach((tt, i) => {
      const px = xPx(tt);
      ctx.strokeStyle = xGridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + pH);
      ctx.stroke();
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, pad.top + pH);
      ctx.lineTo(px, pad.top + pH + 5);
      ctx.stroke();
      // Edge labels align inward so they don't clip off the canvas
      ctx.textAlign = i === 0 ? 'left' : (i === 2 ? 'right' : 'center');
      ctx.fillStyle = xLblColor;
      ctx.fillText(tt.toFixed(1) + 's', px, pad.top + pH + 8);
    });

    if (yMin < 0 && yMax > 0) {
      const zy = yPx(0);
      ctx.save();
      ctx.strokeStyle = zeroColor;
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(pad.left,      zy);
      ctx.lineTo(pad.left + pW, zy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Change34: a series may now carry optional style fields
    // (s.lw = sharp-pass line width, s.alpha = sharp-pass opacity, s.dash = dash pattern)
    // so two overlapping traces stay both visible (e.g. thick faint sim under thin dashed ODEa).
    // Series without these fields draw exactly as before.
    for (const s of visibleSeries) {
      const lineColor = colourOf(s.color);
      if (s.visible.length < 2) continue;
      for (const pass of [
        { blur: 6, alpha: 0.28, lw: 2.5 },
        { blur: 0, alpha: s.alpha ?? 1.0, lw: s.lw ?? 1.3 },  //Ch34-Edt: sharp pass takes the series' own opacity and width if given, else the old 1.0 / 1.3
      ]) {
        ctx.save();
        ctx.globalAlpha = pass.alpha;
        ctx.strokeStyle = lineColor;
        ctx.setLineDash(s.dash ?? []);  //Ch34-Add: apply the series' dash pattern (or solid if none) to both glow and sharp passes
        ctx.lineWidth   = pass.lw;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.shadowColor = lineColor;
        ctx.shadowBlur  = pass.blur;
        ctx.beginPath();
        let first = true;
        for (const d of s.visible) {
          const px = xPx(d.t);
          const py = yPx(d.value);
          if (px < pad.left - 1) { first = true; continue; }
          first ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          first = false;
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(pad.left - 0.5, pad.top - 0.5, pW + 1, pH + 1);

    // Change36: this.opts.label/unit were set by every
    // renderMulti() caller's constructor but never drawn here — only the single-series
    // render() method drew a title (see its "Label (top-left inside plot...)" block).
    // Restoring that: a neutral (non-trace-colour) title line above the per-series legend.
    if (this.opts.label) { //Ch36-Add: only draw a title row if one was configured (keeps charts with no label unchanged)
      ctx.font         = 'bold 10px "Courier New", monospace'; //Ch36a-Edt: was 'bold 12px' — smaller so long titles ('Pivot accel: sim/ODE (rad/s²)') fit inside narrow chart columns instead of clipping at the canvas edge 
      ctx.textAlign    = 'left';                                //Ch36-Add: left-aligned, matching the legend
      ctx.textBaseline = 'top';                                 //Ch36-Add: anchor at the row's top edge
      ctx.fillStyle    = labelColor;                             //Ch36-Add: neutral theme colour (not a trace colour), so it reads as a title, not a series entry
      ctx.shadowBlur   = 0;                                      //Ch36-Add: no glow on the title text
      const titleUnitStr = this.opts.unit ? ` (${this.opts.unit})` : ''; //Ch36-Add: same "(unit)" suffix convention as the legend
      ctx.fillText(this.opts.label + titleUnitStr, pad.left + 5, pad.top + 4); //Ch36-Add: draw the title at the same top-left anchor the legend uses
    }

    // ── Legend (stacked labels, one per series, top-left) ─────────────────
    // Change38: dropped the per-series "(unit)" suffix here — since
    // Change36 added the chart-level title above (which already shows this.opts.unit once), every
    // series repeating the same unit was redundant .
    ctx.font         = 'bold 12px "Courier New", monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    const legendTop = this.opts.label ? pad.top + 4 + 16 : pad.top + 4; //Ch36-Add: push the per-series legend down one row when a title was drawn above it, so they don't overlap
    series.forEach((s, i) => {
      const lineColor = colourOf(s.color);
      ctx.fillStyle   = lineColor;
      ctx.shadowColor = lineColor;
      ctx.shadowBlur  = 6;
      ctx.fillText(s.label, pad.left + 5, legendTop + i * 14); //Ch38-Edt: was `s.label + unitStr` — unit dropped (now shown once in the title above, see Change36)
    });
    ctx.shadowBlur = 0;
  }

  /**
   * Render the chart.
   * @param {Array<{t: number, value: number}>} data  Full history array
   * @param {number}                             tNow  Current simulation time (s)
   */
  render(data, tNow) {
    const ctx   = this.ctx;
    const W     = this.canvas.width;
    const H     = this.canvas.height;
    const light = document.documentElement.dataset.theme === 'light';

    // ── Theme-dependent colour tokens ────────────────────────────────────
    const chartBg     = light ? '#faf6ef'                    : '#070d18';
    const gridColor   = light ? 'rgba(150, 130, 100, 0.50)' : 'rgba(50, 80, 115, 0.75)';
    const xGridColor  = light ? 'rgba(150, 130, 100, 0.40)' : 'rgba(50, 80, 115, 0.60)';
    const tickColor   = light ? 'rgba(100,  90,  70, 0.70)' : 'rgba(120, 170, 210, 0.70)';
    const labelColor  = light ? 'rgba( 40,  55,  70, 0.90)' : 'rgba(195, 225, 245, 0.92)';
    const xLblColor   = light ? 'rgba( 40,  55,  70, 0.85)' : 'rgba(185, 215, 240, 0.88)';
    const zeroColor   = light ? 'rgba(  0, 100, 170, 0.20)' : 'rgba(0, 212, 255, 0.15)';
    const borderColor = light ? 'rgba(130, 115,  95, 0.70)' : 'rgba(45, 75, 115, 0.80)';
    const lineColor   = light
      ? (LIGHT_COLOUR_MAP[this.opts.lineColor] ?? this.opts.lineColor)
      : this.opts.lineColor;

    // Layout margins
    const pad = { top: 20, right: 12, bottom: 28, left: 52 };
    let   pW  = W - pad.left - pad.right; // Ch49-Edt: was const — widened below once the y range (and so the label width) is known
    const pH  = H - pad.top  - pad.bottom;

    // ── Clear and background ─────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = chartBg;
    ctx.fillRect(0, 0, W, H);

    const tMax    = this.opts.scrolling ? tNow : this.opts.windowSecs;
    const tMin    = this.opts.scrolling ? Math.max(0, tNow - this.opts.windowSecs) : 0;
    const visible = data.filter(d => d.t >= tMin - 0.05 && d.t <= tMax + 0.05);

    // ── Y-axis range (auto-scale with padding) ───────────────────────────
    let yMin, yMax;
    if (visible.length === 0) {
      yMin = -1; yMax = 1;
    } else {
      const vals = visible.map(d => d.value);
      let vMin = vals[0], vMax = vals[0];
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vMin) vMin = vals[i];
        if (vals[i] > vMax) vMax = vals[i];
      }
      let range  = vMax - vMin;
      if (range < 1e-6) range = 1;
      yMin = vMin - range * this.opts.yPad;
      yMax = vMax + range * this.opts.yPad;
    }
    // Ensure zero is included when close
    if (yMin > 0 && yMin < (yMax - yMin) * 0.1) yMin = -(yMax - yMin) * 0.05;
    if (yMax < 0 && yMax > (yMax - yMin) * 0.1) yMax =  (yMax - yMin) * 0.05;

    // Pixel-mapping helpers
    pad.left = yLabelPadLeft(ctx, yMin, yMax, 4); // Ch49-Add: widen the left margin to fit the widest y-tick label (4 = yTicks below)
    pW       = W - pad.left - pad.right;          // Ch49-Add: plot width for the widened margin
    const xPx = t => pad.left + ((t - tMin) / this.opts.windowSecs) * pW;
    const yPx = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * pH;

    // ── Grid lines and y-tick labels ─────────────────────────────────────
    const yTicks = 4;
    ctx.font         = '9px "Courier New", monospace'; //Ch42-Edt: was '11px' — requested smaller y-axis tick font
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= yTicks; i++) {
      const v  = yMin + (i / yTicks) * (yMax - yMin);
      const py = yPx(v);

      // Grid line
      ctx.strokeStyle = gridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left,      py);
      ctx.lineTo(pad.left + pW, py);
      ctx.stroke();

      // Tick mark on the axis edge
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.left - 5, py);
      ctx.lineTo(pad.left,     py);
      ctx.stroke();

      // Label
      ctx.fillStyle = labelColor;
      ctx.fillText(v.toFixed(2), pad.left - 8, py); //Ch42-Edt: was v.toFixed(1) — requested 2 decimal places
    }

    // x-tick labels (time) — just 3: left edge, middle, right edge (a denser
    // grid overlapped/cluttered; intermediate values read by eye).
    ctx.font         = '11px "Courier New", monospace';
    ctx.textBaseline = 'top';

    [tMin, (tMin + tMax) / 2, tMax].forEach((tt, i) => {
      const px = xPx(tt);

      // Grid line
      ctx.strokeStyle = xGridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + pH);
      ctx.stroke();

      // Tick mark on the axis edge
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, pad.top + pH);
      ctx.lineTo(px, pad.top + pH + 5);
      ctx.stroke();

      // Label — edge labels align inward so they don't clip off the canvas
      ctx.textAlign = i === 0 ? 'left' : (i === 2 ? 'right' : 'center');
      ctx.fillStyle = xLblColor;
      ctx.fillText(tt.toFixed(1) + 's', px, pad.top + pH + 8);
    });

    // ── Zero reference line ──────────────────────────────────────────────
    if (yMin < 0 && yMax > 0) {
      const zy = yPx(0);
      ctx.save();
      ctx.strokeStyle = zeroColor;
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(pad.left,      zy);
      ctx.lineTo(pad.left + pW, zy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Data trace (two-pass phosphor glow) ──────────────────────────────
    if (visible.length >= 2) {
      for (const pass of [
        { blur: 6, alpha: 0.28,              lw: 2.5 },              // glow layer
        { blur: 0, alpha: this.opts.traceAlpha, lw: this.opts.traceLw }, //Ch36a-Edt: was hardcoded {alpha:1.0, lw:1.3} — now takes the chart's own traceAlpha/traceLw (defaults preserve the old values)
      ]) {
        ctx.save();
        ctx.globalAlpha = pass.alpha;
        ctx.strokeStyle = lineColor;
        ctx.lineWidth   = pass.lw;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.shadowColor = lineColor;
        ctx.shadowBlur  = pass.blur;
        ctx.beginPath();

        let first = true;
        for (const d of visible) {
          const px = xPx(d.t);
          const py = yPx(d.value);
          if (px < pad.left - 1) { first = true; continue; }
          first ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          first = false;
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Plot border ──────────────────────────────────────────────────────
    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(pad.left - 0.5, pad.top - 0.5, pW + 1, pH + 1);

    // ── Label (top-left inside plot, trace colour) ────────────────────────
    ctx.font         = 'bold 10px "Courier New", monospace'; //Ch36a-Edt: was 'bold 12px' — smaller so titles fit inside narrow chart columns instead of clipping , matches renderMulti's title size
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = lineColor;
    ctx.shadowColor  = lineColor;
    ctx.shadowBlur   = 6;
    const unitStr    = this.opts.unit ? ` (${this.opts.unit})` : '';
    ctx.fillText(this.opts.label + unitStr, pad.left + 5, pad.top + 4);
    ctx.shadowBlur   = 0;
  }

  /**
   * Render from a ring buffer of typed arrays (t[], value[]) instead of a
   * plain array — never allocates or filters a full copy of what can be a
   * multi-million-entry history (that O(n)-per-frame cost is exactly what
   * froze the charts at the finest time step — see physics.js's
   * angleHistT/angleHistDeg). Downsamples to ~one min/max pair per
   * horizontal pixel: one pass over the raw samples (cheap — typed-array
   * reads, no allocation, no per-sample draw call), then draws one vertical
   * bar per bucket instead of one lineTo() per raw sample. Min/max per
   * bucket (not just one sample) preserves fast ripple/spikes that naive
   * decimation would lose.
   * @param {Float64Array} tArr    ring buffer of timestamps
   * @param {Float64Array} valArr  ring buffer of values (same indices as tArr)
   * @param {number} count  valid entries written so far (<= tArr.length)
   * @param {number} pos    next write index — the OLDEST valid entry's index
   *   once the buffer has wrapped (count === tArr.length)
   * @param {number} tNow   current sim time (s)
   */
  renderRingBuffer(tArr, valArr, count, pos, tNow) {
    const ctx   = this.ctx;
    const W     = this.canvas.width;
    const H     = this.canvas.height;
    const light = document.documentElement.dataset.theme === 'light';

    const chartBg     = light ? '#faf6ef'                    : '#070d18';
    const gridColor   = light ? 'rgba(150, 130, 100, 0.50)' : 'rgba(50, 80, 115, 0.75)';
    const xGridColor  = light ? 'rgba(150, 130, 100, 0.40)' : 'rgba(50, 80, 115, 0.60)';
    const tickColor   = light ? 'rgba(100,  90,  70, 0.70)' : 'rgba(120, 170, 210, 0.70)';
    const labelColor  = light ? 'rgba( 40,  55,  70, 0.90)' : 'rgba(195, 225, 245, 0.92)';
    const xLblColor   = light ? 'rgba( 40,  55,  70, 0.85)' : 'rgba(185, 215, 240, 0.88)';
    const zeroColor   = light ? 'rgba(  0, 100, 170, 0.20)' : 'rgba(0, 212, 255, 0.15)';
    const borderColor = light ? 'rgba(130, 115,  95, 0.70)' : 'rgba(45, 75, 115, 0.80)';
    const lineColor   = light
      ? (LIGHT_COLOUR_MAP[this.opts.lineColor] ?? this.opts.lineColor)
      : this.opts.lineColor;

    const pad = { top: 20, right: 12, bottom: 28, left: 52 };
    let   pW  = W - pad.left - pad.right; // Ch49-Edt: was const — widened below once the y range (and so the label width) is known
    const pH  = H - pad.top  - pad.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = chartBg;
    ctx.fillRect(0, 0, W, H);

    const capacity = tArr.length;
    if (count === 0 || capacity === 0) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(pad.left - 0.5, pad.top - 0.5, pW + 1, pH + 1);
      return;
    }

    // Buffer not yet wrapped (count < capacity) -> data starts at index 0.
    // Wrapped -> oldest valid entry sits at `pos` (about to be overwritten next).
    const oldestIdx = count < capacity ? 0 : pos;
    const tMin = tArr[oldestIdx];
    const tMax = tNow;
    const span = Math.max(tMax - tMin, 1e-9);

    // ── Single pass: bucket samples into ~one column per pixel ─────────────
    // stride-sample
    // when count is huge relative to what ~1000 buckets need — scanning all 11.5M raw points at
    // the worst-case ring-buffer size (the dt floor) measured ~180ms/render, choppy. Capping at
    // ~50 samples/bucket on average cuts that ~230x with no visible loss —
    // still enough samples per bucket for the min/max envelope to look
    // right, just skips redundant equivalent-content in between.
    const nBuckets  = Math.max(1, Math.min(pW, 1000));
    const bucketMin = new Float64Array(nBuckets).fill(Infinity);
    const bucketMax = new Float64Array(nBuckets).fill(-Infinity);
    const bucketHas = new Uint8Array(nBuckets);
    const stride    = Math.max(1, Math.floor(count / (nBuckets * 50)));

    for (let i = 0; i < count; i += stride) {
      const idx = (oldestIdx + i) % capacity;
      const v   = valArr[idx];
      let b = Math.floor(((tArr[idx] - tMin) / span) * nBuckets);
      if (b < 0) b = 0; else if (b >= nBuckets) b = nBuckets - 1;
      if (v < bucketMin[b]) bucketMin[b] = v;
      if (v > bucketMax[b]) bucketMax[b] = v;
      bucketHas[b] = 1;
    }

    let yMin = Infinity, yMax = -Infinity;
    for (let b = 0; b < nBuckets; b++) {
      if (!bucketHas[b]) continue;
      if (bucketMin[b] < yMin) yMin = bucketMin[b];
      if (bucketMax[b] > yMax) yMax = bucketMax[b];
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    let range = yMax - yMin;
    if (range < 1e-6) range = 1;
    yMin -= range * this.opts.yPad;
    yMax += range * this.opts.yPad;
    if (yMin > 0 && yMin < (yMax - yMin) * 0.1) yMin = -(yMax - yMin) * 0.05;
    if (yMax < 0 && yMax > (yMax - yMin) * 0.1) yMax =  (yMax - yMin) * 0.05;

    pad.left = yLabelPadLeft(ctx, yMin, yMax, 4); // Ch49-Add: widen the left margin to fit the widest y-tick label (4 = yTicks below)
    pW       = W - pad.left - pad.right;          // Ch49-Add: plot width for the widened margin
    const xPx = t => pad.left + ((t - tMin) / span) * pW;
    const yPx = v => pad.top  + (1 - (v - yMin) / (yMax - yMin)) * pH;

    const yTicks = 4;
    ctx.font         = '9px "Courier New", monospace'; //Ch42-Edt: was '11px' — requested smaller y-axis tick font
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= yTicks; i++) {
      const v  = yMin + (i / yTicks) * (yMax - yMin);
      const py = yPx(v);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left,      py);
      ctx.lineTo(pad.left + pW, py);
      ctx.stroke();
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.left - 5, py);
      ctx.lineTo(pad.left,     py);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.fillText(v.toFixed(2), pad.left - 8, py); //Ch42-Edt: was v.toFixed(1) — requested 2 decimal places
    }

    // X ticks — 3, matching the rest of the chart family
    ctx.font         = '11px "Courier New", monospace';
    ctx.textBaseline = 'top';
    [tMin, (tMin + tMax) / 2, tMax].forEach((tt, i) => {
      const px = xPx(tt);
      ctx.strokeStyle = xGridColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(px, pad.top);
      ctx.lineTo(px, pad.top + pH);
      ctx.stroke();
      ctx.strokeStyle = tickColor;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, pad.top + pH);
      ctx.lineTo(px, pad.top + pH + 5);
      ctx.stroke();
      ctx.textAlign = i === 0 ? 'left' : (i === 2 ? 'right' : 'center');
      ctx.fillStyle = xLblColor;
      ctx.fillText(tt.toFixed(1) + 's', px, pad.top + pH + 8);
    });

    if (yMin < 0 && yMax > 0) {
      const zy = yPx(0);
      ctx.save();
      ctx.strokeStyle = zeroColor;
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(pad.left,      zy);
      ctx.lineTo(pad.left + pW, zy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Trace: one vertical min-max bar per bucket (glow + sharp pass, same
    //    two-pass phosphor style as the other charts) ─────────────────────
    for (const pass of [
      { blur: 6, alpha: 0.28, lw: 2.5 },
      { blur: 0, alpha: 1.0,  lw: 1.3 },
    ]) {
      ctx.save();
      ctx.globalAlpha = pass.alpha;
      ctx.strokeStyle = lineColor;
      ctx.lineWidth   = pass.lw;
      ctx.lineCap     = 'round';
      ctx.shadowColor = lineColor;
      ctx.shadowBlur  = pass.blur;
      ctx.beginPath();
      for (let b = 0; b < nBuckets; b++) {
        if (!bucketHas[b]) continue;
        const px = pad.left + ((b + 0.5) / nBuckets) * pW;
        ctx.moveTo(px, yPx(bucketMin[b]));
        ctx.lineTo(px, yPx(bucketMax[b]));
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(pad.left - 0.5, pad.top - 0.5, pW + 1, pH + 1);

    ctx.font         = 'bold 10px "Courier New", monospace'; //Ch36a-Edt: was 'bold 12px' — matches the other two title blocks' size reduction 
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = lineColor;
    ctx.shadowColor  = lineColor;
    ctx.shadowBlur   = 6;
    const unitStr    = this.opts.unit ? ` (${this.opts.unit})` : '';
    ctx.fillText(this.opts.label + unitStr, pad.left + 5, pad.top + 4);
    ctx.shadowBlur   = 0;
  }
}

// ── ChartManager ────────────────────────────────────────────────────────────

/**
 * Manages the chart instances and maps physics history to chart data.
 */
class ChartManager {
  /**
   * @param {HTMLCanvasElement} angleCanvas    canvas for rod-angle chart
   * @param {HTMLCanvasElement} baseCanvas     canvas for base-position chart
   * @param {HTMLCanvasElement} pivotCanvas    canvas for pivot-position chart
   * @param {HTMLCanvasElement} velocityCanvas canvas for base/pivot velocity chart
   * @param {HTMLCanvasElement} odeAngleCanvas canvas for sim-vs-ODEa angle chart
   * @param {HTMLCanvasElement} odeAccelCanvas canvas for sim-vs-ODEa angular-accel chart
   */
  constructor(angleCanvas, baseCanvas, pivotCanvas, velocityCanvas, odeAngleCanvas, odeAccelCanvas) {
    this.noEarthMode = false;

    this.angleChart = new ScrollingChart(angleCanvas, {
      label:      'Rod angle',
      unit:       'deg',
      lineColor:  '#00d4ff',
      // windowSecs is unused here — angleChart is
      // rendered via renderRingBuffer() (dedicated 120s ring buffer, see
      // physics.js angleHistT/angleHistDeg), which derives its own time
      // range from the buffer's actual contents instead.
    });
    this.baseChart = new ScrollingChart(baseCanvas, {
      label:      'Base position',
      unit:       'mm',
      lineColor:  '#f59e0b',
      windowSecs: 20,
    });
    // Change36a: recoloured blue and widened/thinned-opacity so the
    // title text (drawn on top, same colour as the trace) stays legible instead of blending
    // into the line — user-reported "so I can see the title".
    this.pivotChart = new ScrollingChart(pivotCanvas, {
      label:      'Pivot pos', //Ch36a-Edt: was 'Pivot position' — shortened so the title fits the narrow chart column instead of clipping 
      unit:       'mm',
      lineColor:  '#00d4ff', //Ch36a-Edt: was '#a78bfa' (purple) — recoloured blue, matching v_pivot (Change36) and the sim traces (Change34)
      windowSecs: 20,
      traceLw:    5,    //Ch36a-Add: wide trace (was the default 1.3)
      traceAlpha: 0.45, //Ch36a-Add: semi-transparent trace (was the default 1.0) so the opaque title text on top reads clearly
    });
    this.velocityChart = new ScrollingChart(velocityCanvas, {
      label:      'Velocity',
      unit:       'm/s',
      windowSecs: 20,
    });

    // sim-vs-ODEa (analytical) comparison, CLASSICAL mode only —
    // stays blank in other modes/settings since engine.angleRodSmoothHist
    // etc. are simply never populated then (see physics.js
    // _odeaCompareActive()).
    this.odeAngleChart = new ScrollingChart(odeAngleCanvas, {
      label:      'Angle: sim/ODEa', //Ch36a-Edt: was 'Angle: sim vs ODE' — shortened ("vs"->"/") so the title fits the narrow chart column 
      unit:       'deg',
      windowSecs: 20,
    });
    this.odeAccelChart = new ScrollingChart(odeAccelCanvas, {
      label:      'Rod avg ang accel: sim/ODEa', //Ch39-Edt: was 'Angular accel: sim/ODE' (Change38, which itself reverted Change36/36a's 'Pivot accel: sim/ODE') — requested wording; "avg" flags that this is the stroboscopically-smoothed/mean-field value (theta-double-dot), not raw instantaneous rod acceleration
      unit:       'rad/s²',
      windowSecs: 20,
    });
  }

  /** Switch between Earth and FREE modes — updates chart labels. */
  setMode(noEarthMode) {
    this.noEarthMode = noEarthMode;
    this.pivotChart.opts.label = noEarthMode ? 'Pivot (rel. base)'  : 'Pivot position';
  }

  /**
   * Render all charts from the physics engine.
   * @param {PhysicsEngine} engine  the live engine (needs the engine itself, not just its
   *   history array, for the angle chart's ring buffer — see below).
   * @param {number} tNow     engine.t
   */
  render(engine, tNow) {
    const history = engine.history;
    // The angle chart reads the dedicated 120s
    // ring buffer (angleHistT/angleHistDeg) via renderRingBuffer(), not the
    // general `history` array — avoids ever mapping/filtering a
    // multi-million-entry array every frame (see physics.js).
    this.angleChart.renderRingBuffer(
      engine.angleHistT, engine.angleHistDeg, engine.angleHistCount, engine.angleHistPos, tNow
    );
    this.baseChart.render(
      history.map(h => ({ t: h.t, value: h.y_base_mm })),
      tNow
    );
    // In FREE mode show pivot oscillation relative to the drifting base
    this.pivotChart.render(
      history.map(h => ({ t: h.t, value: this.noEarthMode
        ? (h.y_pivot_rel_mm ?? h.y_pivot_mm)
        : h.y_pivot_mm })),
      tNow
    );
    // Change36: v_pivot recoloured blue/wide/semi-transparent and
    // v_base restyled dashed — same "wide translucent blue under thin dashed yellow" pattern
    // as the sim-vs-ODEa charts below (Change34), so the two overlapping traces both stay
    // readable; also keeps "pivot" quantities blue consistently with the pivot-position chart.
    this.velocityChart.renderMulti([
      // Change36a: v_pivot (wide/translucent) must be drawn FIRST/underneath
      // and v_base (dashed) SECOND/on top — renderMulti draws array entries in order, later = on top
      // (see the sim/ODEa charts below, where 'sim' is listed first for the same reason). The original
      // Change36 order had v_base first and v_pivot second, so the wide translucent v_pivot band was
      // actually painted OVER the thin dashed v_base line, hiding it completely — reported 
      // as "the yellow seems behind the blue instead of above."
      {
        data:  history.map(h => ({ t: h.t, value: h.v_pivot })),
        color: '#00d4ff', //Ch36-Edt: was '#a78bfa' (purple) — recoloured blue to match the wide/semi-transparent treatment
        label: 'v_pivot',
        lw:    5,    //Ch36-Add: v_pivot trace drawn thick so it stays visible under the dashed v_base trace
        alpha: 0.45, //Ch36-Add: v_pivot trace semi-transparent so the v_base line on top shows through
      },
      {
        data:  history.map(h => ({ t: h.t, value: h.v_base })),
        color: '#f59e0b',
        label: 'v_base',
        lw:    1.3,      //Ch36-Add: v_base trace thin (unchanged default width)
        dash:  [6, 4],   //Ch36-Add: v_base trace dashed so it reads on top of the wide v_pivot band
      },
    ], tNow);

    // sim-vs-ODEa (analytical) comparison, CLASSICAL mode only —
    // these arrays are simply empty outside that mode, so the charts just
    // render blank.
    this.odeAngleChart.renderMulti([
      {
        data:  engine.angleRodSmoothHist.map(d => ({ t: d.t, value: d.value * 180 / Math.PI })),
        color: '#00d4ff',
        label: 'sim',
        lw:    5,    //Ch34-Add: sim trace drawn thick so it stays visible around the ODEa trace
        alpha: 0.45, //Ch34-Add: sim trace semi-transparent so the ODEa line on top shows through
      },
      {
        data:  engine.ODEa_angleHist.map(d => ({ t: d.t, value: d.value * 180 / Math.PI })),
        color: '#f59e0b',
        label: 'ODEa',
        lw:    1.3,      //Ch34-Add: ODEa trace thin (same as the old default width)
        dash:  [6, 4],   //Ch34-Add: ODEa trace dashed (6 px on, 4 px off) so overlap with sim reads as a dashed line over a solid band
      },
    ], tNow);
    // Change36: same wide-blue/dashed-yellow treatment as the
    // sim-vs-ODEa angle chart above (Change34) — the two lines otherwise overlap so closely
    // (see conversation) that the sim (blue) trace was invisible under the ODEa (yellow) one.
    this.odeAccelChart.renderMulti([
      { data: engine.angAccSmoothHist, color: '#00d4ff', label: 'sim', lw: 5,   alpha: 0.45 }, //Ch36-Add: lw/alpha — wide, semi-transparent sim trace
      { data: engine.ODEa_accelHist,    color: '#f59e0b', label: 'ODEa', lw: 1.3, dash: [6, 4] }, //Ch36-Add: lw/dash — thin dashed ODEa trace on top
    ], tNow);
  }

  /** Toggle between fixed (0–windowSecs) and scrolling (last windowSecs) mode */
  setScrolling(on) {
    this.angleChart.opts.scrolling    = on;
    this.baseChart.opts.scrolling     = on;
    this.pivotChart.opts.scrolling    = on;
    this.velocityChart.opts.scrolling = on;
    this.odeAngleChart.opts.scrolling = on;
    this.odeAccelChart.opts.scrolling = on;
  }

  /** Adjust the visible time window on all charts */
  setWindowSecs(s) {
    this.angleChart.opts.windowSecs    = s;
    this.baseChart.opts.windowSecs     = s;
    this.pivotChart.opts.windowSecs    = s;
    this.velocityChart.opts.windowSecs = s;
    this.odeAngleChart.opts.windowSecs = s;
    this.odeAccelChart.opts.windowSecs = s;
  }
}
