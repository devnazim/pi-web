const MANUAL_RECOVERY_ERROR = /workspace is locked by git|prunable or missing|could not safely isolate the workspace|could not inspect the managed workspace directory|could not capture the workspace filesystem identity|could not verify the git worktree identity|worktree identity changed|could not verify workspace submodules|could not verify (?:the )?(?:stale workspace|managed worktree)|workspace files were preserved|previous deletion could not restore|preserved workspace deletion quarantine|selected directory was preserved|workspace was moved to .* for recovery|initialized submodules|deletion is disabled on windows/i;

export function workspaceDeleteRequiresManualRecovery(error?: string) {
  return MANUAL_RECOVERY_ERROR.test(error ?? '');
}

export function workspaceDeleteIdentityChanged(error?: string) {
  return /worktree identity changed/i.test(error ?? '');
}
