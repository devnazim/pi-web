import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRegistry } from './projects.js';

type Settings = Record<string, any>;
type SettingsBody = { scope?: 'global' | 'project'; settings?: Partial<Settings> };

const editableKeys = [
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'hideThinkingBlock',
  'chatToolOutput',
  'theme',
  'syntaxHighlightTheme',
  'syntaxHighlightThemeLight',
  'syntaxHighlightThemeDark',
  'quietStartup',
  'collapseChangelog',
  'enableInstallTelemetry',
  'doubleEscapeAction',
  'treeFilterMode',
  'showHardwareCursor',
  'editorPaddingX',
  'autocompleteMaxVisible',
  'steeringMode',
  'followUpMode',
  'transport',
  'compaction',
  'branchSummary',
  'retry',
  'terminal',
  'images',
  'enabledModels',
  'warnings',
  'sessionDir',
] as const;

export async function registerSettingsRoutes(app: FastifyInstance, registry: ProjectRegistry) {
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/settings', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return settingsPayload(SettingsManager.create(project.path, getAgentDir()));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Could not load settings' });
    }
  });

  app.put<{ Params: { projectId: string }; Body: SettingsBody }>('/api/projects/:projectId/settings', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const scope = request.body?.scope === 'project' ? 'project' : 'global';
      const filePath = scope === 'project' ? path.join(project.path, '.pi', 'settings.json') : path.join(getAgentDir(), 'settings.json');
      const current = readJson(filePath);
      writeJson(filePath, deepMerge(current, sanitizeSettings(request.body?.settings ?? {})));
      return settingsPayload(SettingsManager.create(project.path, getAgentDir()));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not save settings' });
    }
  });
}

function settingsPayload(manager: SettingsManager) {
  const global = sanitizeSettings(manager.getGlobalSettings());
  const project = sanitizeSettings(manager.getProjectSettings());

  return {
    global,
    project,
    effective: {
      ...global,
      ...project,
      defaultProvider: manager.getDefaultProvider(),
      defaultModel: manager.getDefaultModel(),
      compaction: manager.getCompactionSettings(),
      branchSummary: manager.getBranchSummarySettings(),
      retry: { ...manager.getRetrySettings(), provider: manager.getProviderRetrySettings() },
      terminal: {
        showImages: manager.getShowImages(),
        imageWidthCells: manager.getImageWidthCells(),
        clearOnShrink: manager.getClearOnShrink(),
        showTerminalProgress: manager.getShowTerminalProgress(),
      },
      images: {
        autoResize: manager.getImageAutoResize(),
        blockImages: manager.getBlockImages(),
      },
      defaultThinkingLevel: manager.getDefaultThinkingLevel(),
      hideThinkingBlock: manager.getHideThinkingBlock(),
      theme: manager.getTheme(),
      treeFilterMode: manager.getTreeFilterMode(),
      doubleEscapeAction: manager.getDoubleEscapeAction(),
      steeringMode: manager.getSteeringMode(),
      followUpMode: manager.getFollowUpMode(),
      transport: manager.getTransport(),
      quietStartup: manager.getQuietStartup(),
      collapseChangelog: manager.getCollapseChangelog(),
      enableInstallTelemetry: manager.getEnableInstallTelemetry(),
      showHardwareCursor: manager.getShowHardwareCursor(),
      editorPaddingX: manager.getEditorPaddingX(),
      autocompleteMaxVisible: manager.getAutocompleteMaxVisible(),
      enabledModels: manager.getEnabledModels(),
      warnings: manager.getWarnings(),
      sessionDir: manager.getSessionDir(),
    },
  };
}

function sanitizeSettings(settings: Partial<Settings>) {
  const sanitized: Partial<Settings> = {};
  for (const key of editableKeys) {
    if (Object.hasOwn(settings, key)) (sanitized as Record<string, unknown>)[key] = settings[key as keyof Settings];
  }
  return sanitized;
}

function readJson(filePath: string): Partial<Settings> {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Settings>;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: Partial<Settings>) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function deepMerge<T extends Record<string, unknown>>(base: T, updates: Partial<T>): T {
  const result = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete result[key as keyof T];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = result[key];
      result[key as keyof T] = deepMerge(
        current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {},
        value as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}
