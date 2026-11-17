import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

/** Resolve an allowed file, or return null for a path outside the serving root. */
export async function servedFile(root, path) {
  const file = resolve(root, path);
  if (!inside(root, file)) return null;

  const actualRoot = await realpath(root);
  const actualFile = await realpath(file);
  return inside(actualRoot, actualFile) ? actualFile : null;
}
