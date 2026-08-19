export const PI_WEB_RETRY_DEFAULTS = {
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 4_000,
} as const;

type SettingsRecord = Record<string, unknown>;
type SettingsManagerWithOverrides = {
  getGlobalSettings(): unknown;
  getProjectSettings(): unknown;
  applyOverrides(overrides: { retry: SettingsRecord }): void;
  reload?: (...args: unknown[]) => unknown;
};

const retryDefaultManagers = new WeakSet<object>();

export function applyPiWebRetryDefaults<T extends SettingsManagerWithOverrides>(manager: T): T {
  if (!retryDefaultManagers.has(manager)) {
    const reload = manager.reload?.bind(manager);
    if (reload) {
      manager.reload = async (...args: unknown[]) => {
        const result = await reload(...args);
        applyDefaults(manager);
        return result;
      };
    }
    retryDefaultManagers.add(manager);
  }

  applyDefaults(manager);
  return manager;
}

function applyDefaults(manager: SettingsManagerWithOverrides) {
  const globalRetry = objectSetting(objectSetting(manager.getGlobalSettings()).retry);
  const projectRetry = objectSetting(objectSetting(manager.getProjectSettings()).retry);
  const configuredRetry = { ...globalRetry, ...projectRetry };
  const defaults = Object.fromEntries(
    Object.entries(PI_WEB_RETRY_DEFAULTS).filter(([key]) => configuredRetry[key] === undefined),
  );

  if (Object.keys(defaults).length) manager.applyOverrides({ retry: defaults });
}

function objectSetting(value: unknown): SettingsRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SettingsRecord : {};
}
