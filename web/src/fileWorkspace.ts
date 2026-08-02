export function pathIsAtOrBelow(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

export function remapPathRoot(path: string, previousRoot: string, nextRoot: string) {
  return pathIsAtOrBelow(path, previousRoot) ? `${nextRoot}${path.slice(previousRoot.length)}` : path;
}

export function fileAncestorDirectories(path: string) {
  const directories = [''];
  const parts = path.split('/').filter(Boolean).slice(0, -1);
  for (let index = 1; index <= parts.length; index += 1) directories.push(parts.slice(0, index).join('/'));
  return directories;
}

export function activePathAfterRemoval(paths: string[], activePath: string | undefined, removed: (path: string) => boolean) {
  if (!activePath || !removed(activePath)) return activePath;
  const activeIndex = paths.indexOf(activePath);
  const remaining = paths.filter((path) => !removed(path));
  return remaining[Math.min(Math.max(activeIndex, 0), remaining.length - 1)];
}
