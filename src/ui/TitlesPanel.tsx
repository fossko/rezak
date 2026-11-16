import { useRef, useState } from 'react';
import { S, useStore } from '../store';
import { hub, pickVideo } from './hub';
import { fmtDur } from '../lib/util';
import { clock } from '../lib/util';

/** Вкладка «Заставки»: a library of short intro/outro/header videos. Click one to insert it at the
 *  playhead; delete removes it from the library; a ✕ in «На таймлайне» removes that insertion. */
export function TitlesPanel() {
  useStore((s) => s.version);
  useStore((s) => s.edlRev);
  const p = S.project;
  const lib = S.titleLib;
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const inserts = p?.titles || [];

  const add = async () => {
    const r = await pickVideo();
    if (!r) return;
    setBusy(true);
    try { await S.addTitle(r.file, r.handle); }
    catch (e: any) { S.toast(e.message || String(e), 'err'); }
    finally { setBusy(false); }
  };
  // insert at the text caret: before/after the focused word, else at the playhead
  const anchor = () => {
    const p = S.project;
    if (S.selection && p?.words.length) {
      const b = Math.min(S.selection.b, p.words.length - 1);
      return hub.caretBack ? p.words[b].start : p.words[b].end;
    }
    return hub.player?.currentSrc ?? 0;
  };
  const canInsert = !!p && !!S.edl && S.edl.segments.some((s) => anchor() >= s.start && anchor() < s.end);

  return (
    <div className="panel">
      <div className="hint tip">Заставки — короткие видео (интро, аутро, шапки), которые вставляются в смонтированное видео в месте текстового курсора (перед/после выделенного слова) или в месте проигрывателя. В тексте она появляется зелёной плашкой ▶, на таймлайне — зелёным блоком; клик выбирает (Delete удаляет, ←/→ подрезают).</div>
      <input id="carver-title-input" type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setBusy(true); S.addTitle(f, null).catch((er: any) => S.toast(er.message || String(er), 'err')).finally(() => setBusy(false)); } }} />
      <input id="carver-title-replace-input" ref={replaceInput} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f || !replacing) return;
          setBusy(true);
          S.replaceTitle(replacing, f, null)
            .then(() => S.toast('Файл заставки заменён, все вставки сохранены', 'ok'))
            .catch((er: any) => S.toast(er.message || String(er), 'err'))
            .finally(() => { setBusy(false); setReplacing(null); });
        }} />
      <div className="row wrap">
        <button className="primary" disabled={busy} onClick={add}>＋ Добавить заставку…</button>
        {p && <span className="hint">{canInsert ? `Вставится в ${clock(anchor())}${S.selection ? ' (в текстовом курсоре)' : ''}` : 'Курсор в вырезанном месте — поставьте его в оставшийся текст'}</span>}
      </div>

      {lib.length === 0 && <div className="dim" style={{ fontSize: 13 }}>Библиотека пуста. Добавьте видео, например intro или outro.</div>}
      {lib.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          {lib.map((t) => (
            <div key={t.id} className="sugg" style={{ cursor: 'pointer' }}
              onClick={() => { if (canInsert) S.insertTitle(t.id, anchor()); else S.toast('Поставьте курсор в оставшееся видео.', 'err'); }}>
              <div className="row">
                <span className="grow"><b>{t.name}</b> <span className="dim">· {fmtDur(t.duration)} · {t.width}×{t.height}</span>
                  {t.videoCodec === 'prores' && <span className="danger"> · ProRes — Chrome не декодирует, замените файл</span>}</span>
                <button className="small ghost" title="Заменить файл, сохранив все вставки" onClick={(e) => { e.stopPropagation(); setReplacing(t.id); replaceInput.current?.click(); }}>↻</button>
                <button className="small ghost" title="Вставить в месте курсора" onClick={(e) => { e.stopPropagation(); if (canInsert) S.insertTitle(t.id, anchor()); }}>＋</button>
                <button className="small ghost danger" title="Удалить из библиотеки" onClick={(e) => { e.stopPropagation(); if (confirm(`Удалить «${t.name}» из библиотеки?`)) S.removeTitleAsset(t.id); }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {inserts.length > 0 && (
        <>
          <b style={{ marginTop: 6 }}>На таймлайне: {inserts.length}</b>
          <div className="col" style={{ gap: 6 }}>
            {inserts.map((ti) => {
              const a = S.titleAssets.get(ti.assetId);
              return (
                <div key={ti.id} className="sugg" style={{ borderColor: 'rgba(108,194,138,.45)' }}>
                  <div className="row">
                    <span className="tag" style={{ background: 'rgba(108,194,138,.15)', color: '#9fe0b6' }}>заставка</span>
                    <span className="grow">{a?.name || '?'} <span className="dim mono" style={{ fontSize: 11.5 }}>@ {clock(ti.anchor)}</span></span>
                    <button className="small" title="Показать на таймлайне" onClick={() => { S.titleSel = { id: ti.id, handle: 'b' }; S.bump(); }}>⌖</button>
                    <button className="small ghost danger" title="Убрать с таймлайна" onClick={() => S.removeTitle(ti.id)}>✕</button>
                  </div>
                  <div className="hint">используется {fmtDur(ti.b - ti.a)}{a ? ` из ${fmtDur(a.duration)}` : ''}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
