/** Re-linking a whole folder of source videos (like Premiere's «Relink»): pick one folder, and every
 *  project whose media file lives there gets its source back. Pure matching — no DOM, unit-testable. */

export interface MediaFile { name: string; size: number; lastModified: number; path: string }
export interface WantedMedia { id: string; name: string; size: number; lastModified: number }

export interface RelinkMatch { id: string; path: string; how: 'name' | 'same-time' }
export interface RelinkPlan {
  matched: RelinkMatch[];
  /** Project ids with no file of the same size (or no name/time match) in the folder. */
  missing: string[];
  /** Project ids where several files fit equally well — the user must pick one by hand. */
  ambiguous: string[];
}

const norm = (s: string) => s.trim().toLowerCase();
const signature = (w: WantedMedia) => `${norm(w.name)}|${w.size}`;

/** Match wanted media against the files found in a folder.
 *  Same size is always required (cheap, and a wrong file is worse than a missing one), then the name,
 *  then the modification time — so renamed copies are still recognised. Two queued projects with the same
 *  file name (two days of shooting) still get distinct files; a genuine tie is reported, never guessed. */
export function planRelink(wanted: readonly WantedMedia[], files: readonly MediaFile[]): RelinkPlan {
  const plan: RelinkPlan = { matched: [], missing: [], ambiguous: [] };
  const used = new Set<string>();
  const pending = new Map<string, number>();
  for (const w of wanted) pending.set(signature(w), (pending.get(signature(w)) || 0) + 1);

  for (const w of wanted) {
    const key = signature(w);
    const later = (pending.get(key) || 1) - 1;
    pending.set(key, later);

    const sized = files.filter((f) => f.size === w.size);
    if (!sized.length) { plan.missing.push(w.id); continue; }
    const byName = sized.filter((f) => norm(f.name) === norm(w.name));
    const byTime = byName.length ? byName : sized.filter((f) => f.lastModified === w.lastModified);
    const how: RelinkMatch['how'] = byName.length ? 'name' : 'same-time';
    if (!byTime.length) { plan.missing.push(w.id); continue; }

    const available = byTime.filter((f) => !used.has(f.path));
    if (!available.length) { plan.ambiguous.push(w.id); continue; }
    // Never guess between equally good files, unless there are enough files for the projects still waiting.
    if (available.length > 1 && available.length > later + 1) { plan.ambiguous.push(w.id); continue; }
    const pick = available[0];
    used.add(pick.path);
    plan.matched.push({ id: w.id, path: pick.path, how });
  }
  return plan;
}
