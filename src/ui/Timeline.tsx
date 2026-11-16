import { useEffect, useRef } from 'react';
import { S, useStore } from '../store';
import { LV_HOP } from '../lib/pcm';
import type { CutRegion } from '../lib/edl';
import { WS } from '../lib/types';
import { hub } from './hub';
import { clock, clamp, followViewStart, lastLE, SR } from '../lib/util';
import { TILE_BLOCKS } from '../lib/dsp';

const DB_MIN = -60, DB_MAX = 0, OV_H = 16, WORDS_H = 18;
const COL = {
  cut: { strip: 'rgba(224,96,90,.55)', tint: 'rgba(224,96,90,.13)', tintSel: 'rgba(224,96,90,.24)', wave: 'rgba(224,96,90,.75)', lvl: 'rgba(224,96,90,.55)' },
  ai: { strip: 'rgba(140,132,255,.75)', tint: 'rgba(140,132,255,.14)', tintSel: 'rgba(140,132,255,.27)', wave: 'rgba(150,142,255,.85)', lvl: 'rgba(140,132,255,.6)' },
};
const kindCache = new WeakMap<object, Map<string, 'ai' | 'cut'>>();
function regionKind(r: CutRegion): 'ai' | 'cut' {
  const edl = S.edl!, key = `${r.sk}|${r.ek}|${S.editRev}`;
  let m = kindCache.get(edl); if (!m) { m = new Map(); kindCache.set(edl, m); }
  const hit = m.get(key); if (hit) return hit;
  const ws = S.project!.words;
  let ai = false, other = false;
  for (let i = Math.max(0, lastLE(ws, r.a, (w) => w.start)); i < ws.length && ws[i].start < r.b; i++) {
    const mid = (ws[i].start + ws[i].end) / 2;
    if (mid < r.a || mid >= r.b || !S.wordState[i]) continue;
    if (S.wordState[i] === WS.Llm) ai = true; else other = true;
  }
  const k = ai && !other ? 'ai' : 'cut';
  m.set(key, k);
  return k;
}
const MIN_SPAN = 1, HANDLE_HIT = 6, WAVE_BELOW = 0.012;

// Loudness colouring of the waveform fill (user spec): quiet stays the base colour, -20…-7 dB goes
// yellow, -7…0 dB red. The dB bands are mapped through the SAME vertical scale the wave is drawn with,
// so the colour always means the real level, not a fixed screen height.
const LOUD_BASE = '#9fb3c8', LOUD_YELLOW = '#e8c25a', LOUD_RED = '#e5533f';
// anchor points of the smooth gradient, dB
const LOUD_DB = { red: -7, yellow: -30, base: -45 };

/** 0 dB → 0 (top), DB_MIN → 1 (bottom): the single vertical scale of both views. */
function offDb(db: number) { return 1 - (clamp(db, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN); }

/** Colour stops for the positive half: (offset 0 = 0 dB peak) → 1; the caller mirrors them. */
function loudStops(off: (db: number) => number) {
  // Smooth, not stepped: solid red at the top, then red→yellow and yellow→base blends. Hard stops made
  // the overview look like a sharp horizontal border instead of a gradient.
  return [
    [0, LOUD_RED],
    [off(LOUD_DB.red), LOUD_RED],
    [off(LOUD_DB.yellow), LOUD_YELLOW],
    [off(LOUD_DB.base), LOUD_BASE],
    [1, LOUD_BASE],
  ] as [number, string][];
}
/** Vertical gradient for the sample view: mirrored around the centre line, `mid` ± `amp`. */
function loudGradSym(g: CanvasRenderingContext2D, mid: number, amp: number) {
  const grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
  for (const [o, c] of loudStops(offDb)) grad.addColorStop(o / 2, c);
  for (const [o, c] of loudStops(offDb)) grad.addColorStop(1 - o / 2, c);
  return grad;
}
/** Vertical gradient for the level bars drawn between `top` and `top + mh`. */
function loudGradDb(g: CanvasRenderingContext2D, top: number, mh: number) {
  const grad = g.createLinearGradient(0, top, 0, top + mh);
  for (const [o, c] of loudStops(offDb)) grad.addColorStop(o, c);
  return grad;
}

interface Drag { which: 'a' | 'b'; region: CutRegion; lo: number; hi: number; t: number }
interface TDrag { id: string; which: 'a' | 'b'; t: number; lo: number; hi: number; _nt?: number }

const msClock = (t: number) => { const s = Math.max(0, t), m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0').replace('.', ',')}`; };

export function Timeline() {
  useStore((s) => s.edlRev);
  useStore((s) => s.cutSel);
  useStore((s) => s.titleSel);
  useStore((s) => s.masterRev);
  const cv = useRef<HTMLCanvasElement>(null);
  const st = useRef({ drawnRev: -1, drawnAt: 0, draws: 0, v0: 0, span: 30, src: 0, dragThr: false, dirty: true, hoverThr: false, W: 1000, drag: null as Drag | null, tdrag: null as TDrag | null, hover: '' as '' | 'a' | 'b' | 'region' | 'title' });

  useEffect(() => hub.onTime((src) => {
    const s = st.current; s.src = src;
    if (hub.player?.playing && (src < s.v0 || src > s.v0 + s.span * 0.8)) s.v0 = followViewStart(src, s.span, S.project?.media.duration || 0);
    s.dirty = true;
  }), []);
  useEffect(() => { st.current.dirty = true; });
  // exact tiles of the processed wave arrive from the DSP worker: redraw without re-rendering React
  useEffect(() => S.live.onWave(() => { st.current.dirty = true; }), []);
  useEffect(() => { (window as any).__carverTimeline = st.current; }, []);

  const xOf = (t: number) => { const s = st.current; return (t - s.v0) / s.span * s.W; };

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = cv.current, s = st.current;
      if (!c || !s.dirty) return;
      s.dirty = false;
      const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
      s.W = W;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const p = S.project, lv = S.levelsView, edl = S.edl, pcm = S.pcm, live = S.live, proc = !!live.state;
      if (!p) return;
      s.drawnRev = S.masterRev; s.drawnAt = performance.now(); s.draws++;
      const D = p.media.duration || 1;
      const sel = S.selectedRegion(), drag = s.drag;
      const regs: CutRegion[] = (edl?.regions || []).map((r) => drag && r === drag.region ? { ...r, [drag.which]: drag.t } as CutRegion : r);
      const top = OV_H + 2, mh = H - top - WORDS_H;
      const x = (t: number) => (t - s.v0) / s.span * W;
      const y = (db: number) => top + mh * (1 - (clamp(db, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN));
      const spp = s.span / W;
      // ---- overview
      g.fillStyle = '#25282d'; g.fillRect(0, 0, W, OV_H);
      for (const r of regs) { g.fillStyle = COL[regionKind(r)].strip; g.fillRect(r.a / D * W, 2, Math.max(1, (r.b - r.a) / D * W), OV_H - 4); }
      g.strokeStyle = '#d9a441'; g.lineWidth = 1; g.strokeRect(s.v0 / D * W + 0.5, 0.5, Math.max(2, s.span / D * W), OV_H - 1);
      g.fillStyle = '#e8e6e1'; g.fillRect(s.src / D * W, 0, 1, OV_H);
      // ---- main regions
      const vis = regs.filter((r) => r.b >= s.v0 && r.a <= s.v0 + s.span);
      for (const r of vis) {
        const isSel = sel && r.sk === sel.sk && r.ek === sel.ek;
        g.fillStyle = isSel ? COL[regionKind(r)].tintSel : COL[regionKind(r)].tint;
        g.fillRect(x(r.a), top, Math.max(1, x(r.b) - x(r.a)), mh + WORDS_H);
        if (r.custom) {
          g.fillStyle = 'rgba(240,168,92,.85)';
          for (let px = Math.floor(x(r.a)); px < x(r.b); px += 6) g.fillRect(px, top, 3, 3);
          g.strokeStyle = 'rgba(240,168,92,.6)'; g.lineWidth = 1;
          g.strokeRect(Math.round(x(r.a)) + 0.5, top + 0.5, Math.max(1, x(r.b) - x(r.a) - 1), mh - 1);
        }
      }
      // ---- waveform
      const cutAt = (t: number) => { const i = lastLE(regs, t, (r) => r.a); return i >= 0 && t < regs[i].b ? COL[regionKind(regs[i])] : null; };
      if (pcm && spp < WAVE_BELOW) {
        const mid = top + mh / 2, amp = mh / 2 - 2;
        // dB scale (was a soft-log amplitude curve, which read almost linear for quiet parts)
        const yAmp = (v: number) => {
          if (!v) return mid;
          const db = 20 * Math.log10(Math.abs(v));
          return mid - Math.sign(v) * (1 - offDb(db)) * amp;
        };
        const gradLoud = loudGradSym(g, mid, amp);
        g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, mid, W, 1);
        // processed sound: render EXACTLY what is on screen (plus a second of pre-roll), nothing else
        const va = Math.max(0, Math.floor(s.v0 * SR)), vb = Math.min(pcm.length, Math.ceil((s.v0 + s.span) * SR) + 1);
        const { data: smp, off } = proc ? live.samples(pcm, va, vb) : { data: pcm, off: 0 };
        for (let px = 0; px < W; px++) {
          const t = s.v0 + px * spp, a = Math.max(0, Math.floor(t * SR)), b = Math.min(pcm.length, Math.max(a + 1, Math.floor((t + spp) * SR)));
          if (a >= pcm.length) break;
          let lo = 32767, hi = -32768;
          for (let k = a - off; k < b - off; k++) { const v = smp[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const cc = cutAt(t + spp / 2);
          g.fillStyle = cc ? cc.wave : gradLoud;
          const y1 = yAmp(hi / 32768), y2 = yAmp(lo / 32768);
          g.fillRect(px, y1, 1, Math.max(1, y2 - y1));
        }
        g.fillStyle = '#75736e'; g.font = '10.5px -apple-system, sans-serif'; g.textBaseline = 'bottom';
        g.fillText(`звуковая волна · ${(spp * 1000).toFixed(spp < 0.002 ? 1 : 0).replace('.', ',')} мс на пиксель`, 6, top + mh - 2);
      } else if (lv) {
        const gradLoud = loudGradDb(g, top, mh);
        const f0 = Math.max(0, Math.floor(s.v0 / LV_HOP)), f1 = Math.min(lv.length, Math.ceil((s.v0 + s.span) / LV_HOP));
        const per = Math.max(1, (f1 - f0) / W);
        // processed sound: the instant block model everywhere, replaced by the exact render tile by tile
        // as the DSP worker delivers the visible range (you can see it "render in" after a change)
        const ex = proc ? live.exact : null, cov = proc ? live.covered : null;
        if (proc) live.requestVisible(f0, f1);
        // silence colouring follows the RAW sound (what the silence threshold and the ducking act on): a boosted
        // breath may rise above the threshold line on screen and still stays grey
        const raw = S.levels ?? lv;
        for (let px = 0; px < W; px++) {
          const a = Math.floor(f0 + px * per), b = Math.min(f1, Math.floor(f0 + (px + 1) * per));
          if (a >= lv.length) break;
          let m = -120, mr = -120;
          for (let k = a; k < Math.max(a + 1, b); k++) {
            const v = ex && cov && cov[(k / TILE_BLOCKS) | 0] ? ex[k] : lv[k];
            if (v > m) m = v;
            if (raw[k] > mr) mr = raw[k];
          }
          const t = (a + 0.5) * LV_HOP;
          const cc = cutAt(t);
          g.fillStyle = cc ? cc.lvl : (mr > p.silence.thresholdDb ? gradLoud : '#566270');
          const yy = y(m); g.fillRect(px, yy, 1, top + mh - yy);
        }
        g.strokeStyle = s.hoverThr || s.dragThr ? '#f0c46a' : 'rgba(217,164,65,.85)'; g.setLineDash([5, 4]); g.lineWidth = s.hoverThr ? 2 : 1;
        const ty = Math.round(y(p.silence.thresholdDb)) + 0.5;
        g.beginPath(); g.moveTo(0, ty); g.lineTo(W, ty); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#d9a441'; g.font = '11px -apple-system, sans-serif'; g.textBaseline = 'alphabetic';
        g.fillText(`порог ${p.silence.thresholdDb} дБ`, 6, ty - 4);
      }
      // ---- заставки: green markers at anchor, width ∝ trimmed fraction
      const boxes: { ins: any; asset: any; x0: number; x1: number; y0: number; y1: number }[] = [];
      for (const ins of (p.titles || [])) {
        const asset = S.titleAssets.get(ins.assetId); if (!asset) continue;
        const cx = x(ins.anchor); if (cx < -80 || cx > W + 80) continue;
        const frac = Math.max(0.08, Math.min(1, (ins.b - ins.a) / Math.max(0.1, asset.duration)));
        const bw = clamp(40 + frac * 60, 44, 100), bh = 26, x0 = cx - bw / 2, y0 = top + mh / 2 - bh / 2;
        boxes.push({ ins, asset, x0, x1: x0 + bw, y0, y1: y0 + bh });
      }
      for (const tb of boxes) {
        const isSel = S.titleSel?.id === tb.ins.id;
        g.fillStyle = isSel ? 'rgba(108,194,138,.35)' : 'rgba(108,194,138,.22)';
        g.fillRect(tb.x0, tb.y0, tb.x1 - tb.x0, tb.y1 - tb.y0);
        g.strokeStyle = isSel ? '#9fe0b6' : 'rgba(108,194,138,.65)'; g.lineWidth = 1;
        g.strokeRect(Math.round(tb.x0) + .5, Math.round(tb.y0) + .5, tb.x1 - tb.x0 - 1, tb.y1 - tb.y0 - 1);
        g.fillStyle = '#cdeeda'; g.font = '10.5px -apple-system, sans-serif'; g.textBaseline = 'middle';
        let label = tb.asset.name; while (label.length > 1 && g.measureText(label).width > tb.x1 - tb.x0 - 8) label = label.slice(0, -1);
        g.fillText(label, tb.x0 + 4, (tb.y0 + tb.y1) / 2);
        if (isSel) for (const w of ['a', 'b'] as const) {
          const hx = w === 'a' ? tb.x0 : tb.x1;
          g.fillStyle = '#f0c46a'; g.fillRect(hx - 1, tb.y0 - 5, 2, tb.y1 - tb.y0 + 10);
          g.fillRect(w === 'a' ? hx : hx - 5, tb.y0 - 5, 5, 5);
        }
      }
      // ---- words
      if (p.words.length && s.span <= 90) {
        g.font = '11.5px -apple-system, sans-serif'; g.textBaseline = 'middle';
        let i = Math.max(0, lastLE(p.words, s.v0, (w) => w.start));
        let lastX = -1e9;
        for (; i < p.words.length; i++) {
          const w = p.words[i]; if (w.start > s.v0 + s.span) break;
          const wx = x(w.start); if (wx < lastX + 4) continue;
          const rm = !!S.wordState[i];
          g.fillStyle = rm ? (S.wordState[i] === WS.Llm ? '#9a93ff' : '#e0605a') : S.wordMute[i] ? '#5d5d5a' : w.kind === 'filler' ? '#f0a85c' : w.kind === 'extra' ? '#b6a98a' : '#c9c6bf';
          const maxW = Math.max(0, x(w.end) - wx + 30);
          let txt = w.text; while (txt.length > 1 && g.measureText(txt).width > maxW) txt = txt.slice(0, -1);
          g.fillText(txt, wx + 1, H - WORDS_H / 2);
          g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(wx, H - WORDS_H, 1, 4);
          if (s.span <= 8) { g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(wx, H - WORDS_H, Math.max(1, x(w.end) - wx), 2); }
          lastX = wx + g.measureText(txt).width;
        }
      }
      // ---- ticks
      g.fillStyle = '#75736e'; g.font = '10.5px -apple-system, sans-serif'; g.textBaseline = 'top';
      const step = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((v) => v / s.span * W > 70) || 600;
      for (let t = Math.ceil(s.v0 / step) * step; t < s.v0 + s.span; t += step) {
        g.fillRect(x(t), top, 1, 5);
        g.fillText(step < 1 ? msClock(t).replace(/0+$/, '').replace(/,$/, '') : clock(t), x(t) + 3, top + 1);
      }
      // ---- cut-region handles
      const sr = sel && regs.find((r) => r.sk === sel.sk && r.ek === sel.ek);
      if (sr) for (const which of ['a', 'b'] as const) {
        const t = sr[which], hx = Math.round(x(t));
        if (hx < -10 || hx > W + 10) continue;
        const active = drag ? drag.which === which : (S.cutSel?.handle === which);
        const custom = which === 'a' ? Math.abs(sr.a - sr.autoA) > 5e-4 : Math.abs(sr.b - sr.autoB) > 5e-4;
        g.fillStyle = active ? '#f0c46a' : '#d9a441';
        g.fillRect(hx - 1, top, 2, mh + WORDS_H);
        const tw = 10, th = 16, tx = which === 'a' ? hx : hx - tw;
        g.fillRect(tx, top, tw, th);
        g.fillStyle = '#1b1407'; for (let k = 0; k < 3; k++) g.fillRect(tx + 3, top + 4 + k * 3, tw - 6, 1);
        if (active || s.hover === which) {
          const auto = which === 'a' ? sr.autoA : sr.autoB, dms = Math.round((t - auto) * 1000);
          const label = msClock(t) + (custom ? `  (${dms > 0 ? '+' : ''}${dms} мс)` : '  авто');
          g.font = '11px -apple-system, sans-serif'; g.textBaseline = 'top';
          const lw = g.measureText(label).width + 10, lx = which === 'a' ? Math.max(0, hx - lw - 2) : Math.min(W - lw, hx + 2);
          g.fillStyle = 'rgba(22,23,26,.92)'; g.fillRect(lx, top + th + 2, lw, 17);
          g.fillStyle = '#f0c46a'; g.fillText(label, lx + 5, top + th + 5);
        }
      }
      // ---- title trim label
      const tsel = S.titleSel && S.titleInsert(S.titleSel.id);
      if (tsel) {
        const tb = boxes.find((b) => b.ins.id === tsel.id);
        if (tb) {
          const label = `подрез: ${msClock(tsel.a)}–${msClock(tsel.b)} (${(tsel.b - tsel.a).toFixed(2)} с)`;
          g.font = '11px -apple-system, sans-serif'; g.textBaseline = 'top';
          const lw = g.measureText(label).width + 10;
          const lx = clamp((tb.x0 + tb.x1) / 2 - lw / 2, 4, W - lw - 4);
          g.fillStyle = 'rgba(22,23,26,.92)'; g.fillRect(lx, tb.y1 + 2, lw, 17);
          g.fillStyle = '#9fe0b6'; g.fillText(label, lx + 5, tb.y1 + 5);
        }
      }
      // ---- playhead
      g.fillStyle = '#f0c46a'; g.fillRect(Math.round(x(s.src)), top, 1.5, H - top);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------------------------------------------------------------- hit testing
  const tAt = (e: { clientX: number; clientY: number }) => {
    const c = cv.current!, r = c.getBoundingClientRect(), s = st.current;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { px, py, t: s.v0 + Math.round(px) / r.width * s.span, ov: py < OV_H, W: r.width, H: r.height };
  };
  const handleAt = (px: number): 'a' | 'b' | null => {
    const r = S.selectedRegion(); if (!r) return null;
    const da = Math.abs(px - xOf(r.a)), db = Math.abs(px - xOf(r.b));
    if (Math.min(da, db) > HANDLE_HIT) return null;
    return da <= db ? 'a' : 'b';
  };
  const regionAt = (t: number) => S.edl?.regions.find((r) => t >= r.a && t < r.b) || null;
  const titleBoxAt = (px: number, py: number) => {
    const p = S.project; if (!p) return null;
    const s = st.current, c = cv.current!, H = c.clientHeight, top = OV_H + 2, mh = H - top - WORDS_H;
    for (const ins of (p.titles || [])) {
      const asset = S.titleAssets.get(ins.assetId); if (!asset) continue;
      const cx = xOf(ins.anchor); if (cx < -80 || cx > s.W + 80) continue;
      const frac = Math.max(0.08, Math.min(1, (ins.b - ins.a) / Math.max(0.1, asset.duration)));
      const bw = clamp(40 + frac * 60, 44, 100), bh = 26, x0 = cx - bw / 2, y0 = top + mh / 2 - bh / 2;
      if (px >= x0 - 6 && px <= x0 + bw + 6 && py >= y0 - 6 && py <= y0 + bh + 6) {
        const da = Math.abs(px - x0), db = Math.abs(px - (x0 + bw));
        const part: 'a' | 'b' | 'body' = Math.min(da, db) <= 7 ? (da <= db ? 'a' : 'b') : 'body';
        return { ins, asset, x0, x1: x0 + bw, part };
      }
    }
    return null;
  };
  const thrY = (H: number) => {
    const p = S.project!; const top = OV_H + 2, mh = H - top - WORDS_H;
    return top + mh * (1 - (clamp(p.silence.thresholdDb, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN));
  };
  const levelView = () => { const s = st.current; return !S.pcm || s.span / s.W >= WAVE_BELOW; };

  const onDown = (e: React.MouseEvent) => {
    const p = S.project; if (!p || e.button !== 0) return;
    const { py, t, ov, W, H, px } = tAt(e), s = st.current;
    if (ov) { const tt = px / W * p.media.duration; s.v0 = followViewStart(tt, s.span, p.media.duration, 0.5); hub.player?.seekSrc(tt); s.dirty = true; return; }
    const tb = titleBoxAt(px, py);
    if (tb && tb.part !== 'body') {
      const ins = tb.ins, spp = s.span / s.W;
      const lo = tb.part === 'a' ? 0 : ins.a + 0.02, hi = tb.part === 'a' ? ins.b - 0.02 : tb.asset.duration;
      s.tdrag = { id: ins.id, which: tb.part, t: ins[tb.part], lo, hi };
      S.titleSel = { id: ins.id, handle: tb.part };
      S.bump();
      e.preventDefault();
      return;
    }
    if (tb) {
      S.titleSel = { id: tb.ins.id, handle: 'b' };
      S.bump();
      const clip = S.composite?.clips.find((c) => c.kind === 'title' && c.titleId === tb.ins.assetId && Math.abs(c.a - tb.ins.a) < 1e-3 && Math.abs(c.b - tb.ins.b) < 1e-3);
      if (clip) hub.player?.seek(clip.out); else hub.player?.seekSrc(tb.ins.anchor);
      s.dirty = true;
      return;
    }
    const h = handleAt(px);
    if (h) {
      const r = S.selectedRegion()!, [lo, hi] = S.edgeLimits(r, h);
      s.drag = { which: h, region: r, lo, hi, t: r[h] };
      S.selectRegion(r, h);
      e.preventDefault();
      return;
    }
    if (levelView() && Math.abs(py - thrY(H)) < 6) { s.dragThr = true; return; }
    const r = regionAt(t);
    if (r) {
      S.selectRegion(r, Math.abs(t - r.a) <= Math.abs(t - r.b) ? 'a' : 'b');
      hub.player?.seekSrc(Math.max(0, r.a - 1.5));
      s.dirty = true;
      return;
    }
    if (S.cutSel) S.selectRegion(null);
    if (S.titleSel) S.titleSel = null;
    hub.player?.seekSrc(clamp(t, 0, p.media.duration));
  };
  const onDouble = (e: React.MouseEvent) => {
    const { px, py, t, ov } = tAt(e); if (ov) return;
    const tb = titleBoxAt(px, py);
    if (tb) { S.resetTitle(tb.ins.id); return; }
    const r = regionAt(t); if (r && r.custom) S.resetRegion(r);
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const s = st.current;
      if (s.tdrag) {
        const td = s.tdrag, { px } = tAt(e), spp = s.span / s.W;
        const originPx = td.which === 'a' ? (() => { const t = S.titleInsert(td.id); return t ? xOf(t.a) : 0; })() : (() => { const t = S.titleInsert(td.id); return t ? xOf(t.b) : 0; })();
        const dt = (px - originPx) * spp;
        td._nt = clamp(td.t + dt, td.lo, td.hi);
        s.dirty = true;
        return;
      }
      const d = s.drag; if (!d || !cv.current) return;
      const { t } = tAt(e);
      d.t = clamp(t, d.lo, d.hi);
      if (xOf(d.t) > s.W - 20) s.v0 = clamp(s.v0 + s.span * 0.02, 0, Math.max(0, S.project!.media.duration - s.span));
      if (xOf(d.t) < 20) s.v0 = Math.max(0, s.v0 - s.span * 0.02);
      s.dirty = true;
    };
    const up = () => {
      const s = st.current;
      if (s.tdrag) {
        const td = s.tdrag;
        if (td._nt != null && Math.abs(td._nt - td.t) > 1e-6) {
          const t = S.titleInsert(td.id);
          if (t) S.trimTitle(td.id, td.which === 'a' ? td._nt : t.a, td.which === 'b' ? td._nt : t.b);
        }
        s.tdrag = null; s.dirty = true; return;
      }
      const d = s.drag; if (!d) { s.dragThr = false; return; }
      s.drag = null;
      if (Math.abs(d.t - d.region[d.which]) > 1e-6) S.setEdge(d.region, d.which, d.t);
      s.dirty = true;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);
  const onMove = (e: React.MouseEvent) => {
    const p = S.project; if (!p) return;
    const { py, H, px, t, ov } = tAt(e), s = st.current;
    if (s.drag || s.tdrag) return;
    if (s.dragThr && e.buttons & 1) {
      const top = OV_H + 2, mh = H - top - WORDS_H;
      const db = Math.round(DB_MIN + (1 - (py - top) / mh) * (DB_MAX - DB_MIN));
      if (db !== p.silence.thresholdDb) S.setSilence({ thresholdDb: clamp(db, -70, -10) });
      return;
    }
    s.dragThr = false;
    const h = handleAt(px);
    const tb = titleBoxAt(px, py);
    const thr = !h && !tb && levelView() && Math.abs(py - thrY(H)) < 6;
    const hover: typeof s.hover = h || (tb ? (tb.part === 'body' ? 'title' : tb.part) : (!ov && regionAt(t) ? 'region' : ''));
    if (thr !== s.hoverThr || hover !== s.hover) {
      s.hoverThr = thr; s.hover = hover; s.dirty = true;
      (e.target as HTMLElement).style.cursor = h || (tb && tb.part !== 'body') ? 'ew-resize' : thr ? 'ns-resize' : 'pointer';
    }
  };
  const zoomBy = (factor: number, at?: number) => {
    const p = S.project; if (!p) return;
    const s = st.current, D = p.media.duration;
    if (at == null) at = s.src >= s.v0 && s.src <= s.v0 + s.span ? s.src : s.v0 + s.span / 2;
    const ns = clamp(s.span * factor, MIN_SPAN, Math.max(10, D));
    s.v0 = clamp(at - (at - s.v0) * ns / s.span, 0, Math.max(0, D - ns)); s.span = ns;
    s.dirty = true;
  };
  useEffect(() => { (window as any).__carverTimelineZoom = zoomBy; }, []);

  useEffect(() => {
    const c = cv.current; if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = S.project; if (!p) return;
      const s = st.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.W : 1;
      if (e.ctrlKey) { const { t } = tAt(e); zoomBy(Math.exp(clamp(e.deltaY * unit, -40, 40) * 0.01), t); return; }
      const d = (Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      s.v0 = clamp(s.v0 + d * s.span / s.W, 0, Math.max(0, p.media.duration - s.span));
      s.dirty = true;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const inn = e.code === 'Equal' || e.code === 'NumpadAdd', out = e.code === 'Minus' || e.code === 'NumpadSubtract';
      if (!inn && !out) return;
      e.preventDefault();
      zoomBy(inn ? 1 / 1.6 : 1.6);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (tg && (tg.tagName === 'INPUT' && !['range', 'checkbox'].includes((tg as HTMLInputElement).type) || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return;
      if (S.titleSel) {
        const t = S.titleInsert(S.titleSel.id);
        if (!t) { S.titleSel = null; return; }
        if (e.key === 'Escape') { S.titleSel = null; e.stopImmediatePropagation(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); S.removeTitle(t.id); return; }
        if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); S.titleSel = { id: t.id, handle: S.titleSel.handle === 'a' ? 'b' : 'a' }; S.bump(); return; }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault(); e.stopImmediatePropagation();
        const s = st.current, spp = s.span / s.W, which = S.titleSel.handle;
        const dt = (e.key === 'ArrowLeft' ? -1 : 1) * spp * (e.shiftKey ? 10 : 1);
        S.trimTitle(t.id, which === 'a' ? t.a + dt : t.a, which === 'b' ? t.b + dt : t.b, true);
        s.dirty = true;
        return;
      }
      if (!S.cutSel) return;
      const r = S.selectedRegion();
      if (!r) { S.selectRegion(null); return; }
      if (e.key === 'Escape') { S.selectRegion(null); e.stopImmediatePropagation(); return; }
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); S.selectRegion(r, S.cutSel.handle === 'a' ? 'b' : 'a'); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopImmediatePropagation();
      const s = st.current, px = s.span / s.W, which = S.cutSel.handle;
      const dt = (e.key === 'ArrowLeft' ? -1 : 1) * px * (e.shiftKey ? 10 : 1);
      S.setEdge(r, which, r[which] + dt, true);
      const nr = S.selectedRegion();
      if (nr) {
        const t = nr[which];
        if (t < s.v0 + s.span * 0.05 || t > s.v0 + s.span * 0.95) s.v0 = clamp(t - s.span / 2, 0, Math.max(0, S.project!.media.duration - s.span));
      }
      s.dirty = true;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="timeline" title="Красный участок — вырезка (ручки двигают границы), зелёный — заставка (ручки подрезают начало/конец). Клик выбрать, Delete удалить заставку, ←/→/Shift/×10 — сдвиг на пиксель, Tab — другая ручка, Esc — снять, двойной щелчок — вернуть авто. Щипок — масштаб, прокрутка — сдвиг.">
      <canvas ref={cv} onMouseDown={onDown} onMouseMove={onMove} onDoubleClick={onDouble} />
      <div className="tl-zoom">
        <button className="small" title="Уменьшить масштаб (⌘−)" onClick={() => zoomBy(1.6)}>−</button>
        <button className="small" title="Увеличить масштаб (⌘=)" onClick={() => zoomBy(1 / 1.6)}>+</button>
      </div>
    </div>
  );
}
