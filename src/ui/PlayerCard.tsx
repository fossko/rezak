import { useEffect, useRef, useState } from 'react';
import { S, useStore, prefs, savePrefs } from '../store';
import { Player } from '../player/player';
import { hub } from './hub';
import { VuMeter } from './VuMeter';
import { clock } from '../lib/util';
import { fullComposite } from '../lib/composite';

const RATES = [0.75, 1, 1.25, 1.5, 2];

export function PlayerCard() {
  const media = useStore((s) => s.media);
  const edl = useStore((s) => s.edl);
  const showOriginal = useStore((s) => s.showOriginal);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState({ out: 0, dur: 0 });

  useEffect(() => {
    if (!media || !canvas.current) return;
    const p = new Player(media, canvas.current);
    p.fade = S.project?.cut.fade ?? 0.012;
    p.rate = prefs.playbackRate || 1;
    hub.player = p;
    (window as any).__carverPlayer = p;
    const offs = [
      p.on('time', ({ out, src }) => {
        setT({ out, dur: p.duration }); for (const f of hub.timeListeners) f(src, out);
        // restoration renders ahead of the playhead: re-plan when it moves to another 2 s step
        if (Math.floor(src / 2) !== Math.floor(S.restoreFocus / 2) || Math.abs(src - S.restoreFocus) > 2) { S.restoreFocus = src; S.restorer.kick(); }
      }),
      p.on('state', ({ playing }) => setPlaying(playing)),
      p.on('error', (msg) => S.toast('Ошибка воспроизведения: ' + msg, 'err')),
    ];
    p.setMutes(S.muteRegions(), S.profOpts().fadeMs / 1000);
    if (S.edl && !S.showOriginal) p.setComposite(S.composite || fullComposite(S.project!.media.duration));
    setT({ out: 0, dur: p.duration });
    return () => { offs.forEach((f) => f()); p.destroy(); if (hub.player === p) hub.player = null; };
  }, [media]);

  // Processed monitoring: every decoded buffer goes through the same leveler and master chain as the
  // export. A change while playing is heard within ~0.1 s (audio-only re-sync, throttled for slider drags).
  const masterRev = useStore((s) => s.masterRev);
  const refreshAt = useRef(0), refreshTimer = useRef(0);
  useEffect(() => {
    const p = hub.player; if (!p) return;
    const m = prefs.audioBypass ? null : S.master;
    p.setMaster(m && S.masterLeveler ? S.masterLeveler.gainAt : null, m ? S.live.chain : null);
    if (!p.playing) return;
    const run = () => { refreshAt.current = performance.now(); refreshTimer.current = 0; p.refreshAudio(); };
    const wait = 150 - (performance.now() - refreshAt.current);
    if (wait <= 0) run();
    else if (!refreshTimer.current) refreshTimer.current = window.setTimeout(run, wait);
  }, [masterRev, media, prefs.audioBypass]);

  // «Реставрация»: dry/wet mixed into every main buffer before the gain curve and the compressor. A new tile
  // near the playhead or a new amount is heard within ~0.15 s (same audio-only re-sync as the master).
  const restoreRev = useStore((s) => s.restoreRev);
  useEffect(() => {
    const p = hub.player; if (!p) return;
    const R = S.restorer;
    p.setRestore(prefs.audioBypass ? null : (s0, n) => R.wet(s0, n), prefs.audioBypass ? 0 : R.amount);
    if (!p.playing) return;
    const run = () => { refreshAt.current = performance.now(); refreshTimer.current = 0; p.refreshAudio(); };
    const wait = 150 - (performance.now() - refreshAt.current);
    if (wait <= 0) run();
    else if (!refreshTimer.current) refreshTimer.current = window.setTimeout(run, wait);
  }, [restoreRev, media, prefs.audioBypass]);

  // follow edits (debounced: slider drags produce many updates)
  useEffect(() => {
    const p = hub.player; if (!p || !S.project) return;
    const id = setTimeout(() => {
      p.fade = S.project!.cut.fade;
      p.setComposite(showOriginal || !S.composite ? fullComposite(S.project!.media.duration) : S.composite);
      p.setMutes(S.muteRegions(), S.profOpts().fadeMs / 1000);
      setT({ out: p.current, dur: p.duration });
    }, 120);
    return () => clearTimeout(id);
  }, [edl, showOriginal, media]);

  const p = hub.player;
  return (
    <div className="player">
      <div className="player-main">
        <div className="player-video"><canvas ref={canvas} onClick={() => p?.toggle()} /></div>
        <VuMeter />
      </div>
      <div className="pctl">
        <button className="small" disabled={!media} onClick={() => p?.toggle()} title="Пробел">{playing ? '❚❚' : '▶'}</button>
        <span className="time mono grow">{clock(t.out)} / {clock(t.dur)}</span>
        <select className="rate" value={prefs.playbackRate} title="Скорость просмотра (на экспорт не влияет)"
          onChange={(e) => { const r = +e.target.value; savePrefs({ playbackRate: r }); hub.player?.setRate(r); e.target.blur(); }}>
          {RATES.map((r) => <option key={r} value={r}>{String(r).replace('.', ',')}×</option>)}
        </select>
        <div className="seg">
          <button className={!showOriginal ? 'on' : ''} onClick={() => { S.showOriginal = false; S.bump(); }} title="Смотреть с вырезанными фрагментами">Результат</button>
          <button className={showOriginal ? 'on' : ''} onClick={() => { S.showOriginal = true; S.bump(); }} title="Смотреть исходник целиком">Исходник</button>
        </div>
      </div>
      <input className="scrub" type="range" min={0} max={Math.max(0.01, t.dur)} step={0.01} value={Math.min(t.out, t.dur)} disabled={!media}
        onChange={(e) => p?.seek(+e.target.value)} style={{ width: '100%', marginTop: 4 }} />
    </div>
  );
}
