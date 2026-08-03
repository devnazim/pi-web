export type ReviewFileTreeNode<T> =
  | { type: 'directory'; name: string; path: string; children: ReviewFileTreeNode<T>[] }
  | { type: 'file'; name: string; path: string; file: T };

type MutableReviewFileTreeDirectory<T> = {
  name: string;
  path: string;
  directories: Map<string, MutableReviewFileTreeDirectory<T>>;
  files: Array<{ name: string; path: string; file: T }>;
};

export function buildReviewFileTree<T extends { path: string }>(files: T[]): ReviewFileTreeNode<T>[] {
  const root: MutableReviewFileTreeDirectory<T> = { name: '', path: '', directories: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let directory = root;
    for (const part of parts) {
      const directoryPath = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = { name: part, path: directoryPath, directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name, path: file.path, file });
  }

  return finalizeReviewFileTree(root);
}

function finalizeReviewFileTree<T>(directory: MutableReviewFileTreeDirectory<T>): ReviewFileTreeNode<T>[] {
  const directories: ReviewFileTreeNode<T>[] = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => ({ type: 'directory', name: child.name, path: child.path, children: finalizeReviewFileTree(child) }));
  const files: ReviewFileTreeNode<T>[] = directory.files
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file) => ({ type: 'file', ...file }));
  return [...directories, ...files];
}
