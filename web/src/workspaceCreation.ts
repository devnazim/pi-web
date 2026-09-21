export type WorkspaceCreationOptions = {
  localBranches: string[];
  startPoints: string[];
  defaultStartPoint: string;
};

export type WorkspaceCreationInput = {
  name?: string;
  branch: string;
  mode: 'new' | 'existing';
  startPoint?: string;
};

export function suggestWorkspaceBranch(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug ? `feat/${slug}` : '';
}

export function workspaceCreationInput(form: { name: string; branch: string; startPoint: string; mode: 'new' | 'existing' }): WorkspaceCreationInput {
  if (!form.branch) throw new Error('Choose a branch.');
  if (form.mode === 'new' && !form.name.trim()) throw new Error('Enter a workspace name.');
  if (form.mode === 'new' && !form.startPoint) throw new Error('Choose a starting point.');
  return {
    name: form.name.trim() || undefined,
    branch: form.branch,
    mode: form.mode,
    ...(form.mode === 'new' ? { startPoint: form.startPoint } : {}),
  };
}
