import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { S, prefs, useStore } from '../store';
import type { Word } from '../lib/types';
import { removedFraction, segAt } from '../lib/edl';
import { clock, lastLE } from '../lib/util';
import { hub, scrubWord } from './hub';

const GAP_SHOW = 0.3;          // pauses at least this long get a chip
const FONT_W = 8.4, LINE_H = 29.75, PARA_PAD = 14;

/** paragraph start indices */
function paraStarts(words: Word[]): number[] {
  const out: number[] = [];
  words.forEach((w, i) => { if (i === 0 || w.para) out.push(i); });
  return out;
}

let curWord = -1;   // word under the playhead (shared with render)

interface ParaProps { k: number; s: number; e: number; top: number; rev: number; edlRev: number; titleByGap: Map<number, any[]>; onMeasure: (k: number, h: number) => void }
const Para = memo(function Para({ k, s, e, top, titleByGap, onMeasure }: ParaProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    onMeasure(k, el.offsetHeight);
    const ro = new ResizeObserver(() => onMeasure(k, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [k, onMeasure]);
  const p = S.project!, words = p.words, ws = S.wordState, edl = S.edl;
  const sel = S.selRange();
  const sugg = suggIndex();
  const cust = customOwners();
  const kids: React.ReactNode[] = [];
  const chip = (t: any) => {
    const asset = S.titleAssets.get(t.assetId);
    const sel = S.titleSel?.id === t.id;
    return (
      <span key={'t' + t.id} className={'tchip' + (sel ? ' sel' : '')} data-title={t.id}
        title={`Заставка «${asset?.name || '?'}» (${(t.b - t.a).toFixed(1).replace('.', ',')} с) — клик: выбрать (Delete удаляет, ←/→ подрезают), на таймлайне зелёная`}>
        ▶ {asset?.name || 'заставка'}{t.b - t.a < (asset?.duration ?? 0) - 0.02 ? ' ✂' : ''}
      </span>
    );
  };
  if (s === 0 && titleByGap.has(-1)) for (const t of titleByGap.get(-1)!) { kids.push(chip(t), ' '); }
  for (let i = s; i < e; i++) {
    const w = words[i];
    let cls = 'w';
    if (ws[i]) cls += ws[i] === 2 ? ' rm llm' : ' rm';
    else if (edl && segAt(edl, (w.start + w.end) / 2) < 0) cls += ' rm';
    if (w.kind === 'extra') cls += ' x';
    else if (w.kind === 'filler') cls += ' x fl';
    else if (w.score != null && w.score < 0.12) cls += ' lowc';
    if (S.wordMute[i]) cls += ' mu';
    if (cust.words.has(i)) cls += ' cust';
    if (sel && i >= sel[0] && i <= sel[1]) cls += ' sel';
    if (sugg[i] >= 0) cls += ' sg';
    if (i === curWord) cls += ' cur';
    kids.push(<span key={i} className={cls} data-i={i}>{w.text}</span>);
    if (titleByGap.has(i)) for (const t of titleByGap.get(i)!) { kids.push(' ', chip(t)); }
    const n = words[i + 1];
    if (n) {
      const gap = n.start - w.end;
      if (gap >= GAP_SHOW) {
        const f = edl ? removedFraction(edl, w.end, n.start) : 0;
        const gc = (f > 0.85 ? 'gap cut' : f > 0.15 ? 'gap part' : 'gap') + (cust.gaps.has(i) ? ' cust' : '');
        kids.push(' ', <span key={'g' + i} className={gc} data-g={i} title={`Пауза ${gap.toFixed(1).replace('.', ',')} с${f > 0.15 ? `, вырезано ${Math.round(f * 100)}%` : ''} — щёлкните, чтобы ${f > 0.5 ? 'вернуть' : 'вырезать'}`}>{gap.toFixed(1).replace('.', ',')}</span>);
      }
      kids.push(' ');
    }
  }
  return (
    <div ref={ref} className="para" style={{ top }} data-k={k}>
      <span className="pt">{clock(words[s].start)}</span>
      {kids}
    </div>
  );
});

/** Words / gaps that own a customized cut edge (shown with a marker, even while the cut is off). */
let custCache: { edges: unknown; words: Set<number>; gaps: Set<number> } | null = null;
function customOwners() {
  const e = S.project!.edges || {};
  if (custCache && custCache.edges === e) return custCache;
  const words = new Set<number>(), gaps = new Set<number>();
  for (const k of Object.keys(e)) {
    const m = /^(rs|re|gs|ge):(-?\d+)/.exec(k); if (!m) continue;
    (m[1][0] === 'r' ? words : gaps).add(+m[2]);
  }
  return (custCache = { edges: e, words, gaps });
}

let suggCache: { rev: number; arr: Int32Array } | null = null;
function suggIndex(): Int32Array {
  const p = S.project!;
  if (suggCache && suggCache.rev === S.editRev && suggCache.arr.length === p.words.length) return suggCache.arr;
  const arr = new Int32Array(p.words.length).fill(-1);
  p.suggestions.forEach((sg, j) => { if (sg.status === 'pending') for (let i = sg.from; i <= sg.to && i < arr.length; i++) arr[i] = j; });
  suggCache = { rev: S.editRev, arr };
  return arr;
}

export function TranscriptView() {
  const words = useStore((s) => s.project!.words);
  const rev = useStore((s) => s.editRev);
  const edlRev = useStore((s) => s.edlRev);
  useStore((s) => s.titleSel);
  const task = useStore((s) => s.task);
  useStore((s) => s.cutSel);   // re-place the caret (dim/undim) when a waveform region is (de)selected
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const [width, setWidth] = useState(760);
  const [, force] = useState(0);
  const starts = useMemo(() => paraStarts(words), [words, words.length]);
  const heights = useRef<number[]>([]);
  const measured = useRef<boolean[]>([]);

  // estimates for unmeasured paragraphs
  const est = useCallback((k: number) => {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : words.length;
    let chars = 0; for (let i = s; i < e; i++) chars += words[i].text.length + 1;
    const lines = Math.max(1, Math.ceil(chars * FONT_W / Math.max(200, width - 56)));
    return lines * LINE_H + PARA_PAD;
  }, [starts, words, width]);
  if (heights.current.length !== starts.length) {
    const h = heights.current, m = measured.current;
    for (let k = 0; k < starts.length; k++) if (!m[k]) h[k] = est(k);
    h.length = starts.length; m.length = starts.length;
  }
  const titleByGap = (() => {
    const m = new Map<number, any[]>();
    for (const t of S.project!.titles || []) {
      const g = lastLE(words, t.anchor, (w) => w.end);
      (m.get(g) || m.set(g, []).get(g)!).push(t);
    }
    return m;
  })();
  const tops = new Float64Array(starts.length + 1);   // cheap (one entry per paragraph): recomputed every render
  for (let k = 0; k < starts.length; k++) tops[k + 1] = tops[k] + (heights.current[k] || est(k));

  const onMeasure = useCallback((k: number, h: number) => {
    const old = heights.current[k];
    if (Math.abs(old - h) < 0.5 && measured.current[k]) return;
    heights.current[k] = h; measured.current[k] = true;
    const sc = scroller.current;
    if (sc && old != null) {
      // keep the view anchored when a paragraph above it changes height
      let top = 0; for (let j = 0; j < k; j++) top += heights.current[j];
      if (top + old <= sc.scrollTop) sc.scrollTop += h - old;
    }
    force((x) => x + 1);
  }, []);

  useEffect(() => {
    const sc = scroller.current; if (!sc) return;
    const ro = new ResizeObserver(() => { setViewH(sc.clientHeight); const inner = sc.firstElementChild as HTMLElement; if (inner) setWidth(inner.clientWidth); });
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { measured.current = []; }, [width]);

  // ---- which paragraphs to render
  const lo = Math.max(0, lastLE(tops, scrollTop - 800, (x) => x));
  let hi = lo; while (hi < starts.length && tops[hi] < scrollTop + viewH + 800) hi++;
  const total = tops[starts.length] || 0;

  // ---- scroll to a word (used by playhead follow & suggestion clicks)
  const scrollToWord = useCallback((i: number, smooth = false) => {
    const sc = scroller.current; if (!sc) return;
    const k = Math.max(0, lastLE(starts, i, (x) => x));
    const el = sc.querySelector(`[data-i="${i}"]`) as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      if (r.top < sr.top + 60 || r.bottom > sr.bottom - 60) sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - sc.clientHeight * 0.35, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      let top = 0; for (let j = 0; j < k; j++) top += heights.current[j] || 0;
      sc.scrollTop = Math.max(0, top - sc.clientHeight * 0.3);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el2 = sc.querySelector(`[data-i="${i}"]`) as HTMLElement | null;
        if (el2) { const r = el2.getBoundingClientRect(), sr = sc.getBoundingClientRect(); sc.scrollTop += r.top - sr.top - sc.clientHeight * 0.35; }
      }));
    }
  }, [starts]);
  useEffect(() => { hub.scrollToWord = scrollToWord; return () => { hub.scrollToWord = null; }; }, [scrollToWord]);

  // ---- ↑/↓: move to the word on the line above/below, like a caret in a text editor.
  // The horizontal "goal column" is kept while moving vertically, so passing through a short line
  // and coming back lands on the same word; any other move resets it.
  const goal = useRef<{ x: number; at: number } | null>(null);
  const lineTarget = useCallback((i: number, dir: 1 | -1): number | null => {
    const sc = scroller.current; if (!sc) return null;
    const cur = sc.querySelector(`[data-i="${i}"]`) as HTMLElement | null;
    if (!cur) { scrollToWord(i); return null; }   // focus word scrolled out of the rendered range: bring it back first
    const R = cur.getBoundingClientRect();
    if (!goal.current || goal.current.at !== i) goal.current = { x: (R.left + R.right) / 2, at: i };
    const gx = goal.current.x, half = R.height / 2;
    let lineTop: number | null = null;
    const cands: { i: number; r: DOMRect }[] = [];
    for (const el of sc.querySelectorAll<HTMLElement>('[data-i]')) {
      const r = el.getBoundingClientRect();
      if (dir > 0 ? r.top > R.top + half : r.bottom < R.bottom - half) {
        cands.push({ i: +el.dataset.i!, r });
        if (lineTop == null || (dir > 0 ? r.top < lineTop : r.top > lineTop)) lineTop = r.top;
      }
    }
    if (lineTop == null) return null;   // first / last line
    let best: number | null = null, bestD = Infinity;
    for (const c of cands) {
      if (Math.abs(c.r.top - lineTop) > half) continue;   // only the adjacent line
      const d = gx < c.r.left ? c.r.left - gx : gx > c.r.right ? gx - c.r.right : 0;
      if (d < bestD) { bestD = d; best = c.i; }
    }
    if (best != null) goal.current = { x: gx, at: best };
    return best;
  }, [scrollToWord]);
  useEffect(() => { hub.lineTarget = lineTarget; return () => { hub.lineTarget = null; }; }, [lineTarget]);

  // ---- playhead word highlight (imperative, no re-render)
  useEffect(() => hub.onTime((src) => {
    const ws = S.project?.words; if (!ws || !ws.length) return;
    const at = lastLE(ws, src + 0.01, (w) => w.start);
    // «Выделение следует за воспроизведением» (Settings / Opt+F): keep the selection on the word under
    // the playhead — while playing, and on pause, because pause() also emits `time`.
    if (prefs.selFollow && at >= 0 && (!S.selection || S.selection.b !== at)) {
      hub.caretBack = false;
      S.setSelection({ a: at, b: at });
    }
    let i = at;
    if (i >= 0 && src > ws[i].end + 0.25 && !(ws[i + 1] && src >= ws[i + 1].start)) i = -1;   // in a pause
    if (i === curWord) return;
    const sc = scroller.current;
    if (curWord >= 0) sc?.querySelector(`[data-i="${curWord}"]`)?.classList.remove('cur');
    curWord = i;
    if (i >= 0) {
      sc?.querySelector(`[data-i="${i}"]`)?.classList.add('cur');
      if (prefs.followPlayhead && hub.player?.playing && performance.now() - hub.userScrolledAt > 4000) scrollToWord(i, true);
    }
  }), [scrollToWord]);

  // ---- mouse selection
  const drag = useRef<{ a: number; moved: boolean } | null>(null);
  const wordAt = (t: EventTarget | null) => { const el = (t as HTMLElement)?.closest?.('[data-i]') as HTMLElement | null; return el ? +el.dataset.i! : -1; };
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const g = (e.target as HTMLElement).closest?.('[data-g]') as HTMLElement | null;
    if (g) { e.preventDefault(); S.toggleGap(+g.dataset.g!); return; }
    const tc = (e.target as HTMLElement).closest?.('[data-title]') as HTMLElement | null;
    if (tc) {
      e.preventDefault();
      const t = S.project!.titles?.find((x) => x.id === tc.dataset.title);
      if (t) {
        S.titleSel = { id: t.id, handle: 'b' }; S.cutSel = null; S.selection = null; S.bump();
        const clip = S.composite?.clips.find((c) => c.kind === 'title' && c.titleId === t.assetId && Math.abs(c.a - t.a) < 1e-3 && Math.abs(c.b - t.b) < 1e-3);
        if (clip) hub.player?.seek(clip.out);
      }
      return;
    }
    const i = wordAt(e.target); if (i < 0) return;
    e.preventDefault();
    if (S.cutSel) S.cutSel = null;   // arrows go back to moving the word selection
    if (S.titleSel) S.titleSel = null;
    hub.caretBack = !!(e.shiftKey && S.selection && i < S.selection.a);
    scroller.current?.focus();
    if (e.shiftKey && S.selection) { S.setSelection({ a: S.selection.a, b: i }); drag.current = { a: S.selection.a, moved: true }; scrubWord(i); }
    else { S.setSelection({ a: i, b: i }); drag.current = { a: i, moved: false }; scrubWord(i); }
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current; if (!d || !(e.buttons & 1)) return;
    const i = wordAt(e.target); if (i < 0) return;
    if (S.selection && S.selection.b !== i) { d.moved = true; hub.caretBack = i < d.a; S.setSelection({ a: d.a, b: i }); scrubWord(i); }
  };
  useEffect(() => {
    const up = () => {
      const d = drag.current; drag.current = null;
      if (d && !d.moved && S.project) { const w = S.project.words[d.a]; if (w) hub.player?.seekSrc(w.start); }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const onDouble = (e: React.MouseEvent) => {
    const i = wordAt(e.target); if (i < 0 || !S.project) return;
    hub.player?.seekSrc(S.project.words[i].start); hub.player?.play();
  };

  // ---- blinking caret at the moving end of the selection (after the focus word, or before it when the
  // last move went backwards). Solid while moving, starts blinking 0.5 s after the last move; dimmed
  // while a waveform region owns the arrow keys.
  const caret = useRef<HTMLDivElement>(null);
  const caretKey = useRef('');
  useLayoutEffect(() => {
    const c = caret.current, sc = scroller.current, sel = S.selection;
    if (!c || !sc) return;
    const el = sel ? sc.querySelector(`[data-i="${sel.b}"]`) as HTMLElement | null : null;
    if (!sel || !el) { c.style.display = 'none'; caretKey.current = ''; return; }
    const inner = c.parentElement!.getBoundingClientRect(), r = el.getBoundingClientRect();
    const back = hub.caretBack || sel.b < sel.a;
    c.style.display = 'block';
    c.style.left = `${(back ? r.left - 2 : r.right) - inner.left}px`;
    c.style.top = `${r.top - inner.top - 1}px`;
    c.style.height = `${r.height + 2}px`;
    c.classList.toggle('idle', !!S.cutSel);
    const key = `${sel.a}:${sel.b}:${back}`;
    if (key !== caretKey.current) {   // moved: restart the blink (solid first)
      caretKey.current = key;
      c.classList.remove('blink'); void c.offsetWidth; c.classList.add('blink');
    }
  });

  const showLive = task?.kind === 'transcribe' || task?.kind === 'extract' || task?.kind === 'models';
  return (
    <div className="tscroll" ref={scroller} tabIndex={0}
      onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
      onWheel={() => { hub.userScrolledAt = performance.now(); }}
      onMouseDown={onDown} onMouseMove={onMove} onDoubleClick={onDouble}>
      <div className="tinner" style={{ height: total + 40 }}>
        {!words.length && (
          <div className="empty">
            {showLive ? <>Идёт подготовка: {task?.text}<br /><span className="dim">Текст появится здесь по мере расшифровки. Тишину можно вырезать уже сейчас — справа.</span></>
              : <>Расшифровки пока нет.</>}
          </div>
        )}
        {starts.slice(lo, hi).map((s, j) => {
          const k = lo + j, e = k + 1 < starts.length ? starts[k + 1] : words.length;
          return <Para key={k} k={k} s={s} e={e} top={tops[k] + 18} rev={rev} edlRev={edlRev} titleByGap={titleByGap} onMeasure={onMeasure} />;
        })}
        <div ref={caret} className="caret" aria-hidden />
        {task?.kind === 'transcribe' && words.length > 0 && task.live && (
          <div className="livebox" style={{ position: 'absolute', top: total + 30, left: 28, right: 28 }}>Распознаётся: …{task.live.slice(-160)}</div>
        )}
      </div>
    </div>
  );
}
