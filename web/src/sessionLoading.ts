export type BranchEntry = { id: string; parentId: string | null };

export function branchForEntry<T extends BranchEntry>(entries: T[], leafId: string | null | undefined) {
  if (leafId === undefined) return entries;
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: T[] = [];
  const visited = new Set<string>();
  let entry = byId.get(leafId);
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

export function boundedRangeAroundIndex(length: number, index: number, size: number) {
  const boundedSize = Math.max(0, size);
  const start = Math.min(
    Math.max(0, index - Math.floor(boundedSize / 2)),
    Math.max(0, length - boundedSize),
  );
  return { start, end: Math.min(length, start + boundedSize) };
}
