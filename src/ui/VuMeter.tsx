import { useEffect, useRef } from 'react';
import { hub } from './hub';
import { VU_FLOOR_DB, vuPercent } from '../lib/vu';

/** Vertical VU meter fed by the Player's analyser, which sits after the leveler, restoration and
 *  compressor/limiter and therefore shows the sound actually being played. */
export function VuMeter() {
  const box = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const peak = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let smooth = VU_FLOOR_DB;
    let peakDb = VU_FLOOR_DB;
    let hold = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const p = hub.player;
      const m = p ? p.meterLevels() : { rmsDb: VU_FLOOR_DB, peakDb: VU_FLOOR_DB };
      // VU ballistics: fast attack, slower release; the peak marker holds briefly, then falls.
      smooth += (m.rmsDb - smooth) * (m.rmsDb > smooth ? 0.55 : 0.12);
      if (m.peakDb >= peakDb) { peakDb = m.peakDb; hold = 0; }
      else if (++hold > 25) peakDb += (VU_FLOOR_DB - peakDb) * 0.06;
      const pct = vuPercent(smooth), pp = vuPercent(peakDb);
      if (fill.current) fill.current.style.clipPath = `inset(${(100 - pct).toFixed(1)}% 0 0)`;
      if (peak.current) {
        peak.current.style.bottom = `${pp.toFixed(1)}%`;
        peak.current.style.opacity = peakDb > VU_FLOOR_DB + 0.5 ? '1' : '0';
      }
      if (box.current) {
        box.current.setAttribute('data-db', smooth.toFixed(1));
        box.current.setAttribute('data-peak', peakDb.toFixed(1));
        box.current.setAttribute('aria-valuenow', smooth.toFixed(0));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="vumeter" ref={box} role="meter" aria-label="Уровень звука после обработки"
      aria-valuemin={VU_FLOOR_DB} aria-valuemax={0} data-vu>
      <div className="vu-fill" ref={fill} />
      <div className="vu-peak" ref={peak} />
    </div>
  );
}
