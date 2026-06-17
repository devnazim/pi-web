import { QueryClient, QueryClientProvider, createInfiniteQuery, createQuery } from '@tanstack/solid-query';
import {
  AlignJustify,
  Archive,
  ArrowUp,
  BadgeInfo,
  Bell,
  Bot,
  Braces,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CodeXml,
  Copy,
  CornerUpLeft,
  Database,
  Ellipsis,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileCheck,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FilePlus,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Files,
  Folder,
  FolderGit,
  FolderOpen,
  GitCompareArrows,
  GitFork,
  Home,
  LoaderCircle,
  MessageSquare,
  Minus,
  Package,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  SquarePen,
  SquareTerminal,
  Tag,
  Trash2,
  User,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-solid';
import type { LucideIcon } from 'lucide-solid';
import { lexer } from 'marked';
import type { Token } from 'marked';
import { For, Show, Suspense, createEffect, createMemo, createSignal, lazy, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import { Portal, render } from 'solid-js/web';
import Sortable from 'sortablejs';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import {
  canStartComposerHistoryNavigation,
  cloneUploadAssets,
  composerHistoryModeForDraft,
  prependComposerHistory,
  readComposerHistory,
  writeComposerHistory,
  type ComposerHistoryItem,
  type ComposerHistoryMode,
  type UploadAsset,
} from './composerHistory';
import { appUrl, appWebSocketUrl } from './appUrl';
import 'monaco-editor/min/vs/editor/editor.main.css';
import './styles.css';

type Project = { id: string; name: string; path: string; color?: ProjectColorId; image?: string };
type ProjectWorkspace = { id: string; rootProjectId: string; name: string; path: string; branch?: string; local: boolean; removable: boolean };
type ProjectColorId = 'slate' | 'gray' | 'zinc' | 'neutral' | 'stone' | 'red' | 'orange' | 'amber' | 'yellow' | 'lime' | 'green' | 'emerald' | 'teal' | 'cyan' | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple' | 'fuchsia' | 'pink' | 'rose';
type ProjectColor = { id: ProjectColorId; label: string; value: string; foreground: string };
type ProjectPreference = { color?: ProjectColorId; image?: string };
type ProjectEditInput = { path: string; color?: ProjectColorId; imageFile?: globalThis.File; clearImage: boolean };
type ProjectFolder = { path: string; displayPath: string; name: string };
type SessionSummary = { id: string; title: string; updatedAt: string; entryCount: number; sessionUuid?: string };
type SessionListResponse = { sessions: SessionSummary[]; nextCursor?: string; total?: number };
type SessionEntry = { type: string; id: string; parentId: string | null; timestamp?: string; role?: string; content?: unknown; text?: string; message?: { role?: string; content?: unknown;[key: string]: unknown };[key: string]: unknown };
type SessionTreeNode = { entry: SessionEntry; children: SessionTreeNode[]; label?: string; labelTimestamp?: string };
type TreeViewNode = Omit<SessionTreeNode, 'children'> & { id: string; children: TreeViewNode[]; display: string; roleClass: string; searchText: string; isSettingsEntry: boolean; isEmptyAssistant: boolean };
type SessionDetail = { sessionId: string; path: string; entries: SessionEntry[]; branch: SessionEntry[]; tree: SessionTreeNode[]; leafId: string | null; name?: string };
type SessionTreeView = Omit<SessionDetail, 'tree'> & { tree: TreeViewNode[] };
type GitFile = { path: string; oldPath?: string; status: string; staged: boolean; unstaged: boolean; additions?: number; deletions?: number; stagedAdditions?: number; stagedDeletions?: number; unstagedAdditions?: number; unstagedDeletions?: number };
type GitFileSelection = { path: string; staged: boolean };
type GitFileActionMenuState = { file: GitFile; staged: boolean; x: number; y: number };
type GitFileDiff = { path: string; staged: boolean; original: string; modified: string; unavailable?: boolean; message?: string; patch?: string };
type ReviewFileDiffState = { key: string; loading: boolean; data?: GitFileDiff; error?: unknown };
type GitStatus = { branch: string; files: GitFile[] };
type ReviewEditorKind = 'diff' | 'patch';
type ReviewDiffEditorViewState = import('monaco-editor').editor.IDiffEditorViewState;
type ReviewPatchEditorViewState = import('monaco-editor').editor.ICodeEditorViewState;
type ReviewEditorState =
  | { kind: 'diff'; key: string; viewState: ReviewDiffEditorViewState }
  | { kind: 'patch'; key: string; viewState: ReviewPatchEditorViewState };
type ReviewWorkspaceState = {
  selected?: GitFileSelection;
  sourceControlOpen: boolean;
  sourceControlWidth: number;
  stagedOpen: boolean;
  unstagedOpen: boolean;
  fileListScrollTop: number;
  fileListScrollLeft: number;
  previewPath?: string;
  commitDialogOpen: boolean;
  commitMessage: string;
  editorState?: ReviewEditorState;
};
type ProjectFileEntry = { name: string; type: 'directory' | 'file' };
type ProjectFilesResponse = { path: string; entries: ProjectFileEntry[] };
type ProjectFilePreview = { path: string; content: string; truncated?: boolean; mtimeMs?: number; size?: number; etag?: string; contentHash?: string };
type ProjectFileSearchEntry = { path: string; name: string; directory: string };
type ToolPanel = 'terminal' | 'tree' | 'review' | 'files';
type ProjectMenuState = { project: Project; x: number; y: number };
type TreeNodeMenuState = { entry: SessionEntry; label?: string; hasChildren: boolean; collapsed: boolean; x: number; y: number };
type FileEntryMenuState = { path: string; name: string; type: ProjectFileEntry['type']; x: number; y: number };
type LabelEditorState = { entry: SessionEntry; label?: string };

type TreeContextAction = 'none' | 'summary' | 'custom';
type TreeSelection = { entry: SessionEntry; branchFromId: string | null; text: string; contextAction: TreeContextAction; customInstructions: string; replaceInstructions: boolean };
type FileMention = { query: string; start: number; end: number; quoted?: boolean };
type SlashCommandMention = { query: string; start: number; end: number };
type CommandArgumentMention = { commandName: string; query: string; start: number; end: number };
type SlashCommand = { name: string; description?: string; source: 'builtin' | 'extension' | 'prompt' | 'skill'; location?: string; path?: string; argumentHint?: string; hasArgumentCompletions?: boolean };
type CommandCompletion = { value: string; label?: string; description?: string };
type BashCommandResult = { output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string };
type AgentStatusInfo = {
  branch?: string;
  sessionName?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; subscription: boolean };
  context?: { tokens: number | null; contextWindow: number; percent: number | null; autoCompact: boolean };
  statuses: Array<{ key: string; text: string }>;
};
type AgentStatusPart = { text: string; title?: string; tone?: 'warning' | 'danger' };
type ModelListItem = { value: string; label: string; provider: string; id: string; reasoning: boolean; thinkingLevels?: ThinkingLevel[] };
type RichTextPart = { text: string; kind?: 'code' | 'file' | 'strong' };
type MarkdownTableCell = { text?: string; tokens?: Token[]; align?: 'center' | 'left' | 'right' | null };
type MarkdownListItemToken = { tokens?: Token[]; text?: string; task?: boolean; checked?: boolean };
type MarkdownToken = Token & {
  align?: Array<'center' | 'left' | 'right' | null>;
  checked?: boolean;
  depth?: number;
  header?: MarkdownTableCell[];
  href?: string;
  items?: MarkdownListItemToken[];
  lang?: string;
  ordered?: boolean;
  raw?: string;
  rows?: MarkdownTableCell[][];
  start?: number | '';
  task?: boolean;
  text?: string;
  title?: string | null;
  tokens?: Token[];
};
type MonacoApi = typeof import('monaco-editor');
type CatppuccinPalette = { base: string; mantle: string; surface0: string; overlay0: string; text: string; subtext0: string; blue: string; lavender: string; sapphire: string; teal: string; green: string; yellow: string; peach: string; red: string; mauve: string; pink: string };
type FlatTreeNode = { node: TreeViewNode; indent: number; showConnector: boolean; isLast: boolean; gutters: Array<{ position: number; show: boolean }>; isVirtualRootChild: boolean };
type TreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all';
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type ChatToolOutputMode = 'compact' | 'expanded' | 'hidden';
type ResolvedThemeMode = 'light' | 'dark';
type ThemeMode = 'system' | ResolvedThemeMode;
type SyntaxHighlightTheme = 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha' | 'vscode-light' | 'vscode-dark';
type ShikiSyntaxTheme = 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha' | 'light-plus' | 'dark-plus';
type ShikiHighlighter = Awaited<ReturnType<(typeof import('shiki/bundle/full'))['createHighlighter']>>;
type ShikiToken = { content: string; color?: string; fontStyle?: number };
type CodeFenceInfo = { label: string; language: string };
type PiSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
  hideThinkingBlock?: boolean;
  chatToolOutput?: ChatToolOutputMode;
  theme?: string;
  syntaxHighlightTheme?: SyntaxHighlightTheme;
  syntaxHighlightThemeLight?: SyntaxHighlightTheme;
  syntaxHighlightThemeDark?: SyntaxHighlightTheme;
  treeFilterMode?: TreeFilterMode;
  quietStartup?: boolean;
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };
  terminal?: { showImages?: boolean; imageWidthCells?: number; clearOnShrink?: boolean; showTerminalProgress?: boolean };
  images?: { autoResize?: boolean; blockImages?: boolean };
};
type PiSettingsResponse = { global: PiSettings; project: PiSettings; effective: PiSettings };
type ChatContentPart = { type: 'text' | 'thinking' | 'tool' | 'image' | 'error'; text: string };
type ToolCallInfo = { id?: string; name: string; args: Record<string, unknown> };
type AgentToolActivity = { id: string; name: string; status: 'running' | 'done' | 'error'; summary?: string };
type AgentRetryActivity = { attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string };
type AgentActivity = { running: boolean; error?: string; text: string; thinking: string; tools: AgentToolActivity[]; notices: string[]; retry?: AgentRetryActivity };
type BashActivity = { running: boolean; error?: string; command?: string; output: string };
type SelectOption = { value: string; label: JSX.Element; disabled?: boolean };
type SessionComposerControls = { model?: string; thinking?: ThinkingLevel | '' };
type ComposerDraft = { text: string; uploads: UploadAsset[]; commandSessionId?: string; treeSelection?: TreeSelection; model?: string; thinking?: ThinkingLevel | '' };
type ChatSearchState = { activeIndex: number; total: number };
type ChatSearchRequest = { seq: number; direction: 1 | -1 };
type WorkspaceNotificationLevel = 'info' | 'success' | 'warning' | 'error';
type WorkspaceNotificationKind = 'agent' | 'command' | 'notice' | 'retry' | 'compaction' | 'review';
type NotificationSoundId = 'chime' | 'ping' | 'pop' | 'bell' | 'ding' | 'boop' | 'pluck' | 'glass' | 'success' | 'warning' | 'alert' | 'silent';
type WorkspaceNotificationItem = { id: string; workspaceId: string; sessionId?: string; title: string; message: string; level: WorkspaceNotificationLevel; kind: WorkspaceNotificationKind; createdAt: number; read: boolean };
type WorkspaceNotificationState = { items: WorkspaceNotificationItem[]; runningSessionIds: string[] };
type WorkspaceNotificationSummary = { total: number; unread: number; running: number; error: boolean; latest?: WorkspaceNotificationItem };
type WorkspaceLookupEntry = { workspace: ProjectWorkspace; project: Project; rootProject: Project };

type WorkspaceNotificationServerEvent = { type?: string; projectId?: string; sessionId?: string; message?: string; data?: unknown };
type FaviconStatus = 'idle' | 'unread' | 'running' | 'error';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const THINKING_LEVEL_VALUE_OPTIONS: SelectOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
];
const COMPOSER_MIN_LINES = 2;
const COMPOSER_MAX_LINES = 7;
const CHAT_SEARCH_DEBOUNCE_MS = 200;
const FILE_SEARCH_DEBOUNCE_MS = 250;
const SETTINGS_CACHE_STALE_TIME_MS = 60_000;
const SESSION_DETAIL_CACHE_STALE_TIME_MS = 30_000;
const CHAT_CODE_HIGHLIGHT_MAX_LENGTH = 200_000;
const CHAT_ROW_ESTIMATED_HEIGHT = 120;
const CHAT_TOOL_OUTPUT_OPTIONS: SelectOption[] = [
  { value: '', label: 'Inherited' },
  { value: 'compact', label: 'Compact/collapsed' },
  { value: 'expanded', label: 'Expanded' },
  { value: 'hidden', label: 'Hidden' },
];
const TREE_FILTER_OPTIONS: SelectOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'no-tools', label: 'No tools' },
  { value: 'user-only', label: 'User only' },
  { value: 'labeled-only', label: 'Labeled only' },
  { value: 'all', label: 'All' },
];
const INHERITED_BOOLEAN_OPTIONS: SelectOption[] = [
  { value: '', label: 'Inherited' },
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
];
const APP_THEME_OPTIONS: SelectOption[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const NOTIFICATION_SOUND_OPTIONS: SelectOption[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'ding', label: 'Ding' },
  { value: 'ping', label: 'Ping' },
  { value: 'pop', label: 'Pop' },
  { value: 'boop', label: 'Boop' },
  { value: 'pluck', label: 'Pluck' },
  { value: 'glass', label: 'Glass' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'alert', label: 'Alert' },
  { value: 'silent', label: 'Silent' },
];
const SYNTAX_HIGHLIGHT_LIGHT_THEME_OPTIONS: SelectOption[] = [
  { value: '', label: 'Default (Catppuccin Latte)' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { value: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { value: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'vscode-light', label: 'VS Code Light' },
  { value: 'vscode-dark', label: 'VS Code Dark' },
];
const SYNTAX_HIGHLIGHT_DARK_THEME_OPTIONS: SelectOption[] = [
  { value: '', label: 'Default (Catppuccin Mocha)' },
  { value: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { value: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { value: 'vscode-dark', label: 'VS Code Dark' },
  { value: 'vscode-light', label: 'VS Code Light' },
];
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});
const TerminalPanel = lazy(() => import('./TerminalPanel'));
const PROJECT_RAIL_WIDTH = 72;
const SESSION_SIDEBAR_DEFAULT_WIDTH = 276;
const SESSION_SIDEBAR_MIN_WIDTH = 220;
const SESSION_SIDEBAR_MAIN_MIN_WIDTH = 480;
const SESSION_SIDEBAR_RESIZE_KEY_STEP = 24;
const TERMINAL_DEFAULT_HEIGHT = 280;
const TERMINAL_MIN_HEIGHT = 160;
const TERMINAL_CHAT_MIN_HEIGHT = 220;
const TERMINAL_RESIZE_KEY_STEP = 24;
const TERMINAL_FILE_CLIENT_INVALIDATION_DEBOUNCE_MS = 750;
const TERMINAL_FILE_SERVER_INVALIDATION_IDLE_MS = 3_000;
const TREE_PANEL_DEFAULT_WIDTH = 560;
const TREE_PANEL_MIN_WIDTH = 360;
const TREE_PANEL_CHAT_MIN_WIDTH = 420;
const TREE_PANEL_RESIZE_KEY_STEP = 24;
const FILE_EXPLORER_DEFAULT_WIDTH = 420;
const FILE_EXPLORER_MIN_WIDTH = 300;
const FILE_EXPLORER_CHAT_MIN_WIDTH = 420;
const FILE_EXPLORER_RESIZE_KEY_STEP = 24;
const REVIEW_SOURCE_CONTROL_DEFAULT_WIDTH = 340;
const REVIEW_SOURCE_CONTROL_MIN_WIDTH = 260;
const REVIEW_PREVIEW_MIN_WIDTH = 420;
const REVIEW_SOURCE_CONTROL_RESIZE_KEY_STEP = 24;
const REVIEW_EDITOR_SCROLL_BEYOND_LAST_COLUMN = 24;
let reviewEditorModelSequence = 0;
const RECENT_PROJECTS_KEY = 'pi-web-recent-projects';
const RECENT_FILES_KEY_PREFIX = 'pi-web-recent-files:';
const fileExplorerPaths = new Map<string, string>();
const composerDrafts = new Map<string, ComposerDraft>();
const OPEN_PROJECTS_KEY = 'pi-web-open-projects';
const ACTIVE_PROJECT_KEY = 'pi-web-active-project';
const PROJECT_QUERY_KEY = 'project';
const WORKSPACE_QUERY_KEY = 'workspace';
const SESSION_QUERY_KEY = 'session';
const WORKSPACES_ENABLED_KEY = 'pi-web-workspaces-enabled';
const WORKSPACE_NOTIFICATIONS_KEY = 'pi-web-workspace-notifications';
const WORKSPACE_NOTIFICATIONS_BROWSER_KEY = 'pi-web-browser-notifications-enabled';
const WORKSPACE_NOTIFICATIONS_SOUND_KEY = 'pi-web-notification-sound-enabled';
const WORKSPACE_NOTIFICATIONS_SOUND_CHOICE_KEY = 'pi-web-notification-sound';
const WORKSPACE_NOTIFICATIONS_SOUND_VOLUME_KEY = 'pi-web-notification-sound-volume';
const DEFAULT_NOTIFICATION_SOUND_VOLUME = 1;
const NOTIFICATION_SOUND_VOLUME_STEP = 0.05;
const WORKSPACE_NOTIFICATIONS_LIMIT = 40;
const WORKSPACE_NOTIFICATION_TOAST_TTL_MS = 8000;
const SESSION_SIDEBAR_OPEN_KEY = 'pi-web-session-sidebar-open';
const DEFAULT_APP_TITLE = 'Pi Web';
const THEME_MODE_KEY = 'pi-web-theme-preference';
const BROWSER_TAB_NAME_KEY = 'pi-web-browser-tab-name';
const CONTRAST_USER_MESSAGES_KEY = 'pi-web-contrast-user-messages';
const LAST_WORKSPACE_SESSIONS_KEY = 'pi-web-last-workspace-sessions-v2';
const SESSION_COMPOSER_CONTROLS_KEY = 'pi-web-session-composer-controls';
const PROJECT_ORDER_KEY = 'pi-web-project-order';
const SESSION_PAGE_SIZE = 30;
const WORKSPACE_SHORTCUT_KEYS = '123456789'.split('');
const CHAT_SEARCH_INPUT_SELECTOR = '[data-chat-search-input="true"]';
const SHORTCUT_BLOCKING_DIALOG_SELECTOR = '.project-modal-backdrop, .confirm-modal-backdrop, .file-search-backdrop, .asset-preview-backdrop';
const KEYBINDINGS_STORAGE_KEY = 'pi-web-keybindings';
const FAVICON_HREF = appUrl('/favicon.svg');
const FAVICON_SIZE = 512;
const FAVICON_BADGE_META: Record<Exclude<FaviconStatus, 'idle'>, { color: string; glyph: 'dot' | 'play' | 'alert' }> = {
  unread: { color: '#f59e0b', glyph: 'dot' },
  running: { color: '#22c55e', glyph: 'play' },
  error: { color: '#ef4444', glyph: 'alert' },
};

// Ctrl+. is an app-specific chord prefix that avoids browser-reserved shortcuts
// like Ctrl/Cmd+F, Ctrl/Cmd+P, and Ctrl/Cmd+,, plus Ctrl/Cmd+K readline/editor conflicts.
const APP_SHORTCUT_CHORD_PREFIX = 'ctrl+.';

const DEFAULT_SHORTCUT_BINDINGS: Record<string, string> = {
  toggleSidebar: `${APP_SHORTCUT_CHORD_PREFIX} b`,
  toggleTerminal: 'ctrl+`',
  toggleFiles: `${APP_SHORTCUT_CHORD_PREFIX} e`,
  toggleReview: `${APP_SHORTCUT_CHORD_PREFIX} g`,
  toggleTree: `${APP_SHORTCUT_CHORD_PREFIX} y`,
  searchChat: `${APP_SHORTCUT_CHORD_PREFIX} f`,
  searchFiles: `${APP_SHORTCUT_CHORD_PREFIX} p`,
  newSession: `${APP_SHORTCUT_CHORD_PREFIX} n`,
  newWorkspace: `${APP_SHORTCUT_CHORD_PREFIX} o`,
  openSettings: `${APP_SHORTCUT_CHORD_PREFIX} ,`,
  toggleTheme: `${APP_SHORTCUT_CHORD_PREFIX} t`,
};

const SHORTCUT_DEFINITIONS: { id: string; name: string; category: string }[] = [
  { id: 'toggleSidebar', name: 'Toggle sessions panel', category: 'Navigation' },
  { id: 'toggleTerminal', name: 'Toggle terminal', category: 'Tool panels' },
  { id: 'toggleFiles', name: 'Toggle file explorer', category: 'Tool panels' },
  { id: 'toggleReview', name: 'Toggle review changes', category: 'Tool panels' },
  { id: 'toggleTree', name: 'Toggle session tree', category: 'Tool panels' },
  { id: 'searchChat', name: 'Search current chat', category: 'Search' },
  { id: 'searchFiles', name: 'Search files', category: 'Search' },
  { id: 'newSession', name: 'Create new session', category: 'Session' },
  { id: 'newWorkspace', name: 'Open project', category: 'Workspace' },
  { id: 'openSettings', name: 'Open settings', category: 'General' },
  { id: 'toggleTheme', name: 'Toggle dark / light theme', category: 'General' },
];
const SHORTCUT_ACTION_IDS = SHORTCUT_DEFINITIONS.map((shortcut) => shortcut.id);
const TERMINAL_SHORTCUT_CHORD_PREFIXES = new Set([APP_SHORTCUT_CHORD_PREFIX]);
const TERMINAL_SINGLE_STEP_SHORTCUT_BINDINGS: Partial<Record<string, Set<string>>> = {
  toggleTerminal: new Set(['ctrl+`']),
  searchFiles: new Set(['mod+p']),
};
const [shortcutBindingsVersion, setShortcutBindingsVersion] = createSignal(0);

function createResizableDimension(options: {
  defaultSize: number;
  minSize: number;
  maxSize: () => number;
  keyStep: number;
  axis: 'x' | 'y';
  dragMultiplier: 1 | -1;
  increaseKey: string;
  decreaseKey: string;
  cursor: 'ew-resize' | 'ns-resize';
}) {
  let stopResize: (() => void) | undefined;
  const [size, setSize] = createSignal(options.defaultSize);
  const [resizing, setResizing] = createSignal(false);
  const setClampedSize = (value: number) => setSize(Math.max(options.minSize, Math.min(options.maxSize(), Math.round(value))));
  const coordinate = (event: PointerEvent) => options.axis === 'x' ? event.clientX : event.clientY;

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startCoordinate = coordinate(event);
    const startSize = size();
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;

    stopResize?.();
    setResizing(true);
    document.documentElement.style.cursor = options.cursor;
    document.documentElement.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setClampedSize(startSize + (coordinate(moveEvent) - startCoordinate) * options.dragMultiplier);
    };
    const stop = () => {
      setResizing(false);
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stopResize = undefined;
    };

    stopResize = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }

  function resizeWithKeyboard(event: KeyboardEvent) {
    let nextSize: number | undefined;
    if (event.key === options.increaseKey) nextSize = size() + options.keyStep;
    else if (event.key === options.decreaseKey) nextSize = size() - options.keyStep;
    else if (event.key === 'PageUp') nextSize = size() + options.keyStep * 4;
    else if (event.key === 'PageDown') nextSize = size() - options.keyStep * 4;
    else if (event.key === 'Home') nextSize = options.minSize;
    else if (event.key === 'End') nextSize = options.maxSize();
    else if (event.key === 'Enter') nextSize = options.defaultSize;
    if (nextSize === undefined) return;
    event.preventDefault();
    setClampedSize(nextSize);
  }

  onCleanup(() => stopResize?.());

  return { size, resizing, maxSize: options.maxSize, setClampedSize, startResize, resizeWithKeyboard };
}

function createReviewWorkspaceState(): ReviewWorkspaceState {
  return {
    sourceControlOpen: true,
    sourceControlWidth: REVIEW_SOURCE_CONTROL_DEFAULT_WIDTH,
    stagedOpen: true,
    unstagedOpen: true,
    fileListScrollTop: 0,
    fileListScrollLeft: 0,
    commitDialogOpen: false,
    commitMessage: '',
  };
}

function reviewFileSelectionKey(selection?: GitFileSelection) {
  return selection ? `${selection.staged ? 'staged' : 'unstaged'}:${selection.path}` : '';
}

function reviewEditorStateKey(path: string, staged: boolean, kind: ReviewEditorKind) {
  return `${staged ? 'staged' : 'unstaged'}:${kind}:${path}`;
}

const PROJECT_COLORS: ProjectColor[] = [
  { id: 'slate', label: 'Slate', value: '0.554 0.046 257.417', foreground: '0.985 0 0' },
  { id: 'gray', label: 'Gray', value: '0.551 0.027 264.364', foreground: '0.985 0 0' },
  { id: 'zinc', label: 'Zinc', value: '0.552 0.016 285.938', foreground: '0.985 0 0' },
  { id: 'neutral', label: 'Neutral', value: '0.556 0 0', foreground: '0.985 0 0' },
  { id: 'stone', label: 'Stone', value: '0.553 0.013 58.071', foreground: '0.985 0 0' },
  { id: 'red', label: 'Red', value: '0.637 0.237 25.331', foreground: '0.985 0 0' },
  { id: 'orange', label: 'Orange', value: '0.705 0.213 47.604', foreground: '0.985 0 0' },
  { id: 'amber', label: 'Amber', value: '0.769 0.188 70.08', foreground: '0.145 0 0' },
  { id: 'yellow', label: 'Yellow', value: '0.795 0.184 86.047', foreground: '0.145 0 0' },
  { id: 'lime', label: 'Lime', value: '0.768 0.233 130.85', foreground: '0.145 0 0' },
  { id: 'green', label: 'Green', value: '0.723 0.219 149.579', foreground: '0.145 0 0' },
  { id: 'emerald', label: 'Emerald', value: '0.696 0.17 162.48', foreground: '0.145 0 0' },
  { id: 'teal', label: 'Teal', value: '0.704 0.14 182.503', foreground: '0.145 0 0' },
  { id: 'cyan', label: 'Cyan', value: '0.715 0.143 215.221', foreground: '0.145 0 0' },
  { id: 'sky', label: 'Sky', value: '0.685 0.169 237.323', foreground: '0.145 0 0' },
  { id: 'blue', label: 'Blue', value: '0.623 0.214 259.815', foreground: '0.985 0 0' },
  { id: 'indigo', label: 'Indigo', value: '0.585 0.233 277.117', foreground: '0.985 0 0' },
  { id: 'violet', label: 'Violet', value: '0.606 0.25 292.717', foreground: '0.985 0 0' },
  { id: 'purple', label: 'Purple', value: '0.627 0.265 303.9', foreground: '0.985 0 0' },
  { id: 'fuchsia', label: 'Fuchsia', value: '0.667 0.295 322.15', foreground: '0.985 0 0' },
  { id: 'pink', label: 'Pink', value: '0.656 0.241 354.308', foreground: '0.985 0 0' },
  { id: 'rose', label: 'Rose', value: '0.645 0.246 16.439', foreground: '0.985 0 0' },
];
const PROJECT_COLOR_IDS = new Set(PROJECT_COLORS.map((color) => color.id));

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function prepareProjectTileDragImage(dataTransfer: DataTransfer, dragEl: HTMLElement, dragOffsetX?: number, dragOffsetY?: number) {
  const rect = dragEl.getBoundingClientRect();
  const padding = 4;
  const wrapper = document.createElement('div');
  const clone = dragEl.cloneNode(true) as HTMLElement;

  const offsetX = Number.isFinite(dragOffsetX ?? Number.NaN) ? dragOffsetX! : rect.width / 2;
  const offsetY = Number.isFinite(dragOffsetY ?? Number.NaN) ? dragOffsetY! : rect.height / 2;

  wrapper.style.position = 'fixed';
  wrapper.style.top = '-10000px';
  wrapper.style.left = '-10000px';
  wrapper.style.padding = `${padding}px`;
  wrapper.style.pointerEvents = 'none';
  wrapper.style.zIndex = '-1';

  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = '0';
  clone.classList.remove('sortable-ghost', 'sortable-chosen', 'sortable-drag');

  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  dataTransfer.setDragImage(wrapper, offsetX + padding, offsetY + padding);

  requestAnimationFrame(() => {
    wrapper.remove();
  });
}

function setProjectTileDragData(dataTransfer: DataTransfer, dragEl: HTMLElement) {
  const dragOffsetX = Number(dragEl.dataset.dragOffsetX);
  const dragOffsetY = Number(dragEl.dataset.dragOffsetY);
  const fallbackOffset = dragEl.getBoundingClientRect();
  delete dragEl.dataset.dragOffsetX;
  delete dragEl.dataset.dragOffsetY;

  dataTransfer.setData('text/plain', dragEl.dataset.id || '');
  prepareProjectTileDragImage(dataTransfer, dragEl, Number.isFinite(dragOffsetX) ? dragOffsetX : fallbackOffset.width / 2, Number.isFinite(dragOffsetY) ? dragOffsetY : fallbackOffset.height / 2);
}


function Shell() {
  const initialActiveSessionId = readActiveSessionId();
  const [projectId, setProjectId] = createSignal<string>();
  const [workspaceProjectId, setWorkspaceProjectId] = createSignal<string>();
  const [sessionId, setSessionId] = createSignal<string | undefined>(initialActiveSessionId);
  const [sessionWorkspaceId, setSessionWorkspaceId] = createSignal<string>();
  const [events, setEvents] = createSignal<string[]>([]);
  const [toolPanel, setToolPanel] = createSignal<ToolPanel>();
  const [reviewInitialSessionSidebarOpen, setReviewInitialSessionSidebarOpen] = createSignal<boolean>();
  const [chatSearchInput, setChatSearchInput] = createSignal('');
  const [chatSearchQuery, setChatSearchQuery] = createSignal('');
  const [chatSearchRequest, setChatSearchRequest] = createSignal<ChatSearchRequest>({ seq: 0, direction: 1 });
  const [chatSearchState, setChatSearchState] = createSignal<ChatSearchState>({ activeIndex: 0, total: 0 });
  const [fileSearchRequest, setFileSearchRequest] = createSignal(0);
  const [openProjectModal, setOpenProjectModal] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [editingProject, setEditingProject] = createSignal<Project>();
  const [projectMenu, setProjectMenu] = createSignal<ProjectMenuState>();
  const [workspacesEnabledByPath, setWorkspacesEnabledByPath] = createSignal(readWorkspacesEnabledByPath());
  const [lastWorkspaceSessions, setLastWorkspaceSessions] = createSignal(readLastWorkspaceSessions());
  const [knownWorkspacesByRootId, setKnownWorkspacesByRootId] = createSignal<Record<string, ProjectWorkspace[]>>({});
  const [workspaceNotificationStore, setWorkspaceNotificationStore] = createSignal<Record<string, WorkspaceNotificationState>>(readWorkspaceNotificationStore());
  const [notificationToasts, setNotificationToasts] = createSignal<WorkspaceNotificationItem[]>([]);
  const [notificationPanelWorkspaceId, setNotificationPanelWorkspaceId] = createSignal<string>();
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = createSignal(readBrowserNotificationsEnabled());
  const [notificationSoundEnabled, setNotificationSoundEnabled] = createSignal(readNotificationSoundEnabled());
  const [notificationSoundId, setNotificationSoundId] = createSignal<NotificationSoundId>(readNotificationSoundId());
  const [notificationSoundVolume, setNotificationSoundVolume] = createSignal(readNotificationSoundVolume());
  const [sessionSidebarOpen, setSessionSidebarOpen] = createSignal(localStorage.getItem(SESSION_SIDEBAR_OPEN_KEY) !== 'false');
  const [restoredOpenProjects, setRestoredOpenProjects] = createSignal(false);
  const [restoringOpenProjects, setRestoringOpenProjects] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(readThemeMode());
  const [browserTabName, setBrowserTabName] = createSignal(readBrowserTabName());
  const [contrastUserMessages, setContrastUserMessages] = createSignal(readContrastUserMessages());
  const [systemThemeMode, setSystemThemeMode] = createSignal<ResolvedThemeMode>(readSystemThemeMode());
  const [appError, setAppError] = createSignal<{ title: string; description: string }>();
  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [mobileMenuOpen, setMobileMenuOpen] = createSignal(false);
  const [mobileToolPopover, setMobileToolPopover] = createSignal(false);
  const [sessionDeleteOpen, setSessionDeleteOpen] = createSignal(false);
  const [sessionRenameOpen, setSessionRenameOpen] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  const [sessionActionBusy, setSessionActionBusy] = createSignal(false);
  const [sessionActionError, setSessionActionError] = createSignal('');
  const [shareFeedback, setShareFeedback] = createSignal(false);
  const initialActiveProjectPath = readActiveProjectPath();
  const initialActiveWorkspacePath = readActiveWorkspacePath();
  const [pendingActiveWorkspacePath, setPendingActiveWorkspacePath] = createSignal(initialActiveWorkspacePath);
  let initialSessionRestorePending = Boolean(initialActiveSessionId);
  let workspaceSessionRestoredForId: string | undefined;
  let workspaceSessionRestoreRequest = 0;
  let workspaceSessionRestoreTarget: { workspaceId: string; sessionId: string; request: number } | undefined;
  let shellSplitRef: HTMLDivElement | undefined;
  const sessionSidebar = createResizableDimension({
    defaultSize: SESSION_SIDEBAR_DEFAULT_WIDTH,
    minSize: SESSION_SIDEBAR_MIN_WIDTH,
    maxSize: () => Math.max(SESSION_SIDEBAR_MIN_WIDTH, (shellSplitRef?.getBoundingClientRect().width ?? window.innerWidth) - PROJECT_RAIL_WIDTH - SESSION_SIDEBAR_MAIN_MIN_WIDTH),
    keyStep: SESSION_SIDEBAR_RESIZE_KEY_STEP,
    axis: 'x',
    dragMultiplier: 1,
    increaseKey: 'ArrowRight',
    decreaseKey: 'ArrowLeft',
    cursor: 'ew-resize',
  });

  const auth = createQuery(() => ({ queryKey: ['auth'], queryFn: ({ signal }) => api<{ authenticated: boolean; required: boolean }>('/api/auth/status', { signal }) }));
  const projects = createQuery(() => ({ queryKey: ['projects'], queryFn: ({ signal }) => api<{ projects: Project[] }>('/api/projects', { signal }), enabled: auth.data?.authenticated !== false }));
  const orderedProjects = createMemo(() => orderProjects(projects.data?.projects ?? [], readProjectOrder()));
  const activeProject = createMemo(() => {
    const currentProjects = orderedProjects();
    const selectedProject = currentProjects.find((project) => project.id === projectId());
    if (selectedProject) return selectedProject;
    const activePath = initialActiveProjectPath ?? readActiveProjectPath();
    const activePathProject = currentProjects.find((project) => project.path === activePath);
    if (activePathProject) return activePathProject;
    if (activePath && !restoredOpenProjects()) return undefined;
    return currentProjects[0];
  });
  const workspacesEnabled = createMemo(() => {
    const project = activeProject();
    return project ? Boolean(workspacesEnabledByPath()[project.path]) : false;
  });
  const workspaces = createQuery(() => ({
    queryKey: ['workspaces', activeProject()?.id],
    queryFn: ({ signal }) => api<{ workspaces: ProjectWorkspace[] }>(`/api/projects/${activeProject()!.id}/workspaces`, { signal }),
    enabled: Boolean(activeProject()?.id && workspacesEnabled()),
  }));
  const projectWorkspaces = createMemo(() => {
    const project = activeProject();
    return (workspaces.data?.workspaces ?? []).filter((workspace) => !project || workspace.rootProjectId === project.id);
  });
  const workspaceLookup = createMemo<Record<string, WorkspaceLookupEntry>>(() => {
    const byId: Record<string, WorkspaceLookupEntry> = {};
    for (const project of projects.data?.projects ?? []) {
      const localWorkspace = projectWorkspaceFromProject(project);
      byId[localWorkspace.id] = { workspace: localWorkspace, project, rootProject: project };
      for (const workspace of knownWorkspacesByRootId()[project.id] ?? []) {
        byId[workspace.id] = {
          workspace,
          project: { id: workspace.id, name: workspace.local ? project.name : workspace.name, path: workspace.path, color: project.color, image: project.image },
          rootProject: project,
        };
      }
    }
    return byId;
  });
  const workspaceNotificationSummaries = createMemo(() => {
    const summaries: Record<string, WorkspaceNotificationSummary> = {};
    for (const workspaceId of Object.keys(workspaceLookup())) summaries[workspaceId] = workspaceNotificationSummary(workspaceNotificationStore()[workspaceId]);
    return summaries;
  });
  const faviconStatus = createMemo(() => faviconStatusFromSummaries(Object.values(workspaceNotificationSummaries())));
  const projectNotificationSummaries = createMemo(() => {
    const summaries: Record<string, WorkspaceNotificationSummary> = {};
    const lookup = workspaceLookup();
    for (const project of projects.data?.projects ?? []) {
      const workspaceIds = Object.values(lookup).filter((entry) => entry.rootProject.id === project.id).map((entry) => entry.workspace.id);
      summaries[project.id] = mergeWorkspaceNotificationSummaries(workspaceIds.map((workspaceId) => workspaceNotificationSummary(workspaceNotificationStore()[workspaceId])));
    }
    return summaries;
  });
  const notificationPanelWorkspace = createMemo(() => {
    const workspaceId = notificationPanelWorkspaceId();
    return workspaceId ? workspaceLookup()[workspaceId] : undefined;
  });
  const workspacesError = createMemo(() => workspacesEnabled() && workspaces.error ? errorMessage(workspaces.error, 'Could not load workspaces') : undefined);
  const workspaceModeActive = createMemo(() => workspacesEnabled() && !workspacesError());
  const activeWorkspace = createMemo(() => {
    const project = activeProject();
    if (!project) return undefined;
    if (!workspaceModeActive()) return projectWorkspaceFromProject(project);
    return projectWorkspaces().find((workspace) => workspace.id === workspaceProjectId())
      ?? projectWorkspaces().find((workspace) => workspace.local)
      ?? projectWorkspaceFromProject(project);
  });
  const workspaceProject = createMemo<Project | undefined>(() => {
    const project = activeProject();
    const workspace = activeWorkspace();
    if (!project || !workspace) return project;
    return { id: workspace.id, name: workspace.local ? project.name : workspace.name, path: workspace.path, color: project.color, image: project.image };
  });
  const activeSessionId = createMemo(() => {
    const id = sessionId();
    const owner = sessionWorkspaceId();
    const workspaceId = workspaceProject()?.id;
    return id && owner && workspaceId && owner === workspaceId ? id : undefined;
  });
  const currentSessionRunning = createMemo(() => {
    const project = workspaceProject();
    const id = activeSessionId();
    return Boolean(project && id && workspaceNotificationState(workspaceNotificationStore()[project.id]).runningSessionIds.includes(id));
  });
  const resolvedThemeMode = createMemo<ResolvedThemeMode>(() => {
    const mode = themeMode();
    return mode === 'system' ? systemThemeMode() : mode;
  });
  let pendingEventPayloads: string[] = [];
  let pendingEventsFrame: number | undefined;

  function queueAgentEvent(payload: string) {
    pendingEventPayloads.push(payload);
    if (pendingEventsFrame !== undefined) return;
    pendingEventsFrame = window.requestAnimationFrame(() => {
      const payloads = pendingEventPayloads;
      pendingEventPayloads = [];
      pendingEventsFrame = undefined;
      setEvents((items) => [...items, ...payloads].slice(-240));
    });
  }

  function resetAgentEvents(payloads: string[] = []) {
    pendingEventPayloads = [];
    if (pendingEventsFrame !== undefined) {
      window.cancelAnimationFrame(pendingEventsFrame);
      pendingEventsFrame = undefined;
    }
    setEvents(payloads);
  }

  function setActiveSession(id: string | undefined, workspaceId = workspaceProject()?.id) {
    setSessionWorkspaceId(id ? workspaceId : undefined);
    setSessionId(id);
  }

  function updateAgentStatusCache(projectId: string, eventSessionId: string, data: unknown) {
    if (!data || typeof data !== 'object') return;
    const statuses = (data as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) return;
    const nextStatuses = statuses
      .filter((status): status is { key: string; text: string } => Boolean(status) && typeof status.key === 'string' && typeof status.text === 'string');
    queryClient.setQueryData<{ status: AgentStatusInfo }>(['agent-status', projectId, eventSessionId], (current) => current ? { status: { ...current.status, statuses: nextStatuses } } : current);
  }

  function updateWorkspaceNotifications(workspaceId: string, updater: (state: WorkspaceNotificationState) => WorkspaceNotificationState) {
    setWorkspaceNotificationStore((current) => {
      const next = { ...current, [workspaceId]: pruneWorkspaceNotificationState(updater(workspaceNotificationState(current[workspaceId]))) };
      writeWorkspaceNotificationStore(next);
      return next;
    });
  }

  function markWorkspaceNotificationsRead(workspaceId: string) {
    updateWorkspaceNotifications(workspaceId, (state) => ({ ...state, items: state.items.map((item) => item.read ? item : { ...item, read: true }) }));
    setNotificationToasts((items) => items.filter((item) => item.workspaceId !== workspaceId));
  }

  function markWorkspaceSessionNotificationsRead(workspaceId: string, targetSessionId: string | undefined) {
    updateWorkspaceNotifications(workspaceId, (state) => ({
      ...state,
      items: state.items.map((item) => item.read || item.sessionId !== targetSessionId ? item : { ...item, read: true }),
    }));
    setNotificationToasts((items) => items.filter((item) => item.workspaceId !== workspaceId || item.sessionId !== targetSessionId));
  }

  function clearWorkspaceNotifications(workspaceId: string) {
    updateWorkspaceNotifications(workspaceId, (state) => ({ ...state, items: [] }));
    setNotificationToasts((items) => items.filter((item) => item.workspaceId !== workspaceId));
  }

  function clearProjectNotifications(project: Project) {
    const workspaceIds = Object.values(workspaceLookup()).filter((entry) => entry.rootProject.id === project.id).map((entry) => entry.workspace.id);
    const targets = workspaceIds.length ? workspaceIds : [project.id];
    setWorkspaceNotificationStore((current) => {
      const next = { ...current };
      for (const workspaceId of targets) {
        next[workspaceId] = { ...workspaceNotificationState(next[workspaceId]), items: [] };
      }
      writeWorkspaceNotificationStore(next);
      return next;
    });
    setNotificationToasts((items) => items.filter((item) => !targets.includes(item.workspaceId)));
  }

  function removeNotificationToast(id: string) {
    setNotificationToasts((items) => items.filter((item) => item.id !== id));
  }

  function showNotificationToast(notification: WorkspaceNotificationItem) {
    setNotificationToasts((items) => [notification, ...items.filter((item) => item.id !== notification.id)].slice(0, 4));
    playWorkspaceNotificationSound(notification.level);
    window.setTimeout(() => removeNotificationToast(notification.id), WORKSPACE_NOTIFICATION_TOAST_TTL_MS);
  }

  function playWorkspaceNotificationSound(level: WorkspaceNotificationLevel) {
    if (notificationSoundEnabled()) playNotificationSound(level, notificationSoundId(), notificationSoundVolume());
  }

  function toggleWorkspaceNotifications(workspaceId: string) {
    setNotificationPanelWorkspaceId((current) => current === workspaceId ? undefined : workspaceId);
  }

  function setNotificationSound(enabled: boolean) {
    setNotificationSoundEnabled(enabled);
    localStorage.setItem(WORKSPACE_NOTIFICATIONS_SOUND_KEY, String(enabled));
    if (enabled) void unlockWorkspaceNotificationSound();
  }

  function setNotificationSoundChoice(sound: NotificationSoundId) {
    setNotificationSoundId(sound);
    localStorage.setItem(WORKSPACE_NOTIFICATIONS_SOUND_CHOICE_KEY, sound);
  }

  function setNotificationSoundVolumePreference(volume: number) {
    const next = clampNotificationSoundVolume(volume);
    setNotificationSoundVolume(next);
    localStorage.setItem(WORKSPACE_NOTIFICATIONS_SOUND_VOLUME_KEY, next.toFixed(2));
  }

  function setBrowserTabNamePreference(name: string) {
    const next = name.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    const trimmed = next.trim();
    setBrowserTabName(next);
    if (trimmed) localStorage.setItem(BROWSER_TAB_NAME_KEY, trimmed);
    else localStorage.removeItem(BROWSER_TAB_NAME_KEY);
  }

  function setContrastUserMessagePreference(enabled: boolean) {
    setContrastUserMessages(enabled);
    localStorage.setItem(CONTRAST_USER_MESSAGES_KEY, String(enabled));
  }

  function rememberWorkspaceSession(workspaceId: string, id: string) {
    setLastWorkspaceSessions((current) => {
      if (current[workspaceId] === id) return current;
      const next = { ...current, [workspaceId]: id };
      writeLastWorkspaceSessions(next);
      return next;
    });
  }

  function forgetWorkspaceLastSession(workspaceId: string) {
    setLastWorkspaceSessions((current) => {
      if (!(workspaceId in current)) return current;
      const next = { ...current };
      delete next[workspaceId];
      writeLastWorkspaceSessions(next);
      return next;
    });
  }

  function forgetLastWorkspaceSessionId(id: string) {
    setLastWorkspaceSessions((current) => {
      let changed = false;
      const next = { ...current };
      for (const [workspaceId, sessionId] of Object.entries(next)) {
        if (sessionId !== id) continue;
        delete next[workspaceId];
        changed = true;
      }
      if (!changed) return current;
      writeLastWorkspaceSessions(next);
      return next;
    });
  }

  function cachedSessionKnown(workspaceId: string, id: string) {
    if (queryClient.getQueryData<SessionDetail>(['session', workspaceId, id])) return true;
    const sessionPages = queryClient.getQueryData<{ pages?: SessionListResponse[] }>(['sessions', workspaceId]);
    return Boolean(sessionPages?.pages?.some((page) => page.sessions.some((session) => session.id === id)));
  }

  async function restoreRememberedWorkspaceSession(workspaceId: string, id: string, request: number) {
    workspaceSessionRestoreTarget = { workspaceId, sessionId: id, request };
    try {
      if (!cachedSessionKnown(workspaceId, id)) {
        await queryClient.fetchQuery({
          queryKey: ['session', workspaceId, id],
          queryFn: ({ signal }) => api<SessionDetail>(`/api/projects/${workspaceId}/session?sessionId=${encodeURIComponent(id)}`, { signal }),
          staleTime: SESSION_DETAIL_CACHE_STALE_TIME_MS,
        });
      }
      if (workspaceSessionRestoreRequest !== request || workspaceProjectId() !== workspaceId) return;
      setActiveSession(id, workspaceId);
    } catch (error) {
      if (workspaceSessionRestoreRequest !== request || workspaceProjectId() !== workspaceId) return;
      if (apiErrorStatus(error) === 404) {
        forgetWorkspaceLastSession(workspaceId);
        if (toolPanel() === 'tree') setToolPanel(undefined);
      } else {
        setActiveSession(id, workspaceId);
      }
    } finally {
      if (workspaceSessionRestoreTarget?.request === request) workspaceSessionRestoreTarget = undefined;
    }
  }

  async function previewNotificationSound() {
    await unlockWorkspaceNotificationSound();
    playNotificationSound('info', notificationSoundId(), notificationSoundVolume());
  }

  function isWorkspaceNotificationViewed(workspaceId: string, notificationSessionId: string | undefined) {
    if (workspaceProject()?.id !== workspaceId) return false;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
    return notificationSessionId ? activeSessionId() === notificationSessionId : true;
  }

  function maybeShowBrowserNotification(notification: WorkspaceNotificationItem, workspace: WorkspaceLookupEntry, viewed: boolean) {
    if (!browserNotificationsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (viewed) return;
    try {
      const nativeNotification = new Notification(notification.title, {
        body: `${workspace.workspace.local ? workspace.rootProject.name : workspace.workspace.name}: ${notification.message}`,
        tag: `pi-web:${notification.workspaceId}:${notification.kind}`,
        silent: notification.level !== 'error',
      });
      nativeNotification.onclick = () => {
        window.focus();
        openWorkspaceNotification(notification);
        nativeNotification.close();
      };
    } catch {
      // Notification permission can change while the page is open.
    }
  }

  function handleWorkspaceNotificationEvent(workspaceId: string, event: WorkspaceNotificationServerEvent) {
    const workspace = workspaceLookup()[workspaceId];
    const sessionId = event.sessionId;
    const read = isWorkspaceNotificationViewed(workspaceId, sessionId);
    const runningSessionId = sessionId ?? 'active';
    const notification = workspaceNotificationFromEvent(event, workspaceId, read);

    updateWorkspaceNotifications(workspaceId, (state) => {
      let runningSessionIds = state.runningSessionIds;
      if (event.type === 'agent:start' || event.type === 'bash:start') runningSessionIds = uniqueStrings([...runningSessionIds, runningSessionId]);
      if (event.type === 'agent:finish' || event.type === 'agent:error' || event.type === 'bash:finish' || event.type === 'bash:error' || event.type === 'error') runningSessionIds = runningSessionIds.filter((id) => id !== runningSessionId);
      return notification ? { runningSessionIds, items: [notification, ...state.items] } : { ...state, runningSessionIds };
    });

    if ((event.type === 'agent:finish' || event.type === 'agent:error' || event.type === 'bash:finish' || event.type === 'bash:error') && sessionId) {
      queryClient.invalidateQueries({ queryKey: ['session', workspaceId, sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-tree', workspaceId, sessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['agent-status', workspaceId, sessionId] });
      invalidateProjectFileCaches(workspaceId);
    }

    if (!notification) return;
    if (!read) showNotificationToast(notification);
    if (workspace) maybeShowBrowserNotification(notification, workspace, read);
  }

  function openWorkspaceNotification(notification: WorkspaceNotificationItem) {
    const workspace = workspaceLookup()[notification.workspaceId];
    if (workspace) {
      setActiveSession(undefined, workspace.workspace.id);
      setProjectId(workspace.rootProject.id);
      resetWorkspaceSelection(workspace.workspace.id);
      writeActiveProjectPath(workspace.rootProject.path);
      if (notification.sessionId) {
        workspaceSessionRestoreRequest += 1;
        setActiveSession(notification.sessionId, workspace.workspace.id);
        rememberWorkspaceSession(workspace.workspace.id, notification.sessionId);
        if (!eventsBelongToSession(events(), notification.sessionId)) resetAgentEvents([]);
      }
    }
    markWorkspaceNotificationsRead(notification.workspaceId);
    setNotificationPanelWorkspaceId(notification.workspaceId);
    removeNotificationToast(notification.id);
  }

  async function enableBrowserNotifications() {
    if (!('Notification' in window)) {
      setAppError({ title: 'Browser notifications unavailable', description: 'This browser does not support notifications.' });
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    const enabled = permission === 'granted';
    setBrowserNotificationsEnabled(enabled);
    localStorage.setItem(WORKSPACE_NOTIFICATIONS_BROWSER_KEY, String(enabled));
    if (!enabled) setAppError({ title: 'Browser notifications blocked', description: 'Enable notifications for this site in your browser settings to receive workspace alerts.' });
  }

  onCleanup(() => {
    if (pendingEventsFrame !== undefined) window.cancelAnimationFrame(pendingEventsFrame);
  });

  onMount(() => {
    let chordTimer: number | undefined;
    let chordPrefix: string | undefined;
    const clearShortcutChord = () => {
      chordPrefix = undefined;
      if (chordTimer !== undefined) {
        window.clearTimeout(chordTimer);
        chordTimer = undefined;
      }
    };
    const startShortcutChord = (prefix: string) => {
      clearShortcutChord();
      chordPrefix = prefix;
      chordTimer = window.setTimeout(clearShortcutChord, 1600);
    };
    const runShortcutAction = (id: string) => {
      if (id === 'toggleSidebar') {
        toggleSessionSidebar();
        return true;
      }
      if (id === 'toggleTerminal') return toggleShortcutToolPanel('terminal');
      if (id === 'toggleFiles') return toggleShortcutToolPanel('files');
      if (id === 'toggleReview') return toggleShortcutToolPanel('review');
      if (id === 'toggleTree') return toggleShortcutToolPanel('tree');
      if (id === 'searchChat') {
        focusChatSearch();
        return true;
      }
      if (id === 'searchFiles') return openFileSearchFromShortcut();
      if (id === 'openSettings') {
        setSettingsOpen((open) => !open);
        return true;
      }
      if (id === 'newSession') {
        startNewSession();
        return true;
      }
      if (id === 'newWorkspace') {
        setOpenProjectModal(true);
        return true;
      }
      if (id === 'toggleTheme') {
        toggleThemeMode();
        return true;
      }
      return false;
    };
    const handleShortcutKeyDown = (event: KeyboardEvent, terminalCapture = false) => {
      const target = shortcutTargetElement(event);
      const inTerminal = Boolean(target?.closest('.terminal-host'));
      if (terminalCapture && !inTerminal) return;
      if (event.defaultPrevented || event.isComposing || event.repeat) return;

      const key = normalizedShortcutKey(event);
      const typingTarget = isShortcutTypingTarget(target);
      const inMonaco = Boolean(target?.closest('.monaco-editor'));
      const blockingDialogOpen = hasBlockingShortcutDialog();
      const typingShortcutBlocked = typingTarget && !event.ctrlKey && !event.metaKey && !event.altKey;
      const terminalShortcutBlocked = (id: string, steps: string[]) => inTerminal && !isTerminalShortcutAllowed(id, steps);
      const canRunShortcut = (id: string, steps: string[], continuingChord = false) => {
        const blockedByTyping = !continuingChord && typingShortcutBlocked;
        const blockedByTerminal = terminalShortcutBlocked(id, steps);
        if (id === 'toggleTerminal') return !blockedByTerminal && !blockingDialogOpen && !blockedByTyping;
        if (id === 'openSettings') return !blockedByTerminal && !inMonaco && (!blockingDialogOpen || settingsOpen()) && !blockedByTyping;
        if (id === 'searchChat' || id === 'searchFiles') return !blockedByTerminal && !inMonaco && !blockingDialogOpen && !blockedByTyping;
        return !blockingDialogOpen && !blockedByTerminal && !inMonaco && !blockedByTyping;
      };
      const consumeShortcut = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      if (chordPrefix) {
        if (isModifierShortcutKey(key)) return;
        if (chordPrefix === APP_SHORTCUT_CHORD_PREFIX && !typingTarget && !blockingDialogOpen && !inTerminal && !inMonaco) {
          const workspaceKey = workspaceShortcutEventKey(event);
          const workspaceIndex = workspaceKey ? WORKSPACE_SHORTCUT_KEYS.indexOf(workspaceKey) : -1;
          if (workspaceIndex !== -1 && selectShortcutWorkspace(workspaceIndex)) {
            consumeShortcut();
            clearShortcutChord();
            return;
          }
        }
        for (const id of SHORTCUT_ACTION_IDS) {
          const steps = bindingSteps(getShortcutBinding(id));
          if (steps.length > 1 && equivalentBindingStep(steps[0], chordPrefix) && matchBindingStep(steps[1], event) && canRunShortcut(id, steps, true)) {
            consumeShortcut();
            clearShortcutChord();
            runShortcutAction(id);
            return;
          }
        }
        consumeShortcut();
        clearShortcutChord();
        return;
      }

      for (const id of SHORTCUT_ACTION_IDS) {
        const steps = bindingSteps(getShortcutBinding(id));
        if (steps.length === 1 && matchBindingStep(steps[0], event) && canRunShortcut(id, steps) && runShortcutAction(id)) {
          consumeShortcut();
          return;
        }
      }

      for (const id of SHORTCUT_ACTION_IDS) {
        const steps = bindingSteps(getShortcutBinding(id));
        if (steps.length > 1 && matchBindingStep(steps[0], event) && canRunShortcut(id, steps)) {
          consumeShortcut();
          startShortcutChord(steps[0]);
          return;
        }
      }
    };
    const onTerminalCaptureKeyDown = (event: KeyboardEvent) => handleShortcutKeyDown(event, true);
    const onKeyDown = (event: KeyboardEvent) => handleShortcutKeyDown(event);

    window.addEventListener('keydown', onTerminalCaptureKeyDown, true);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      clearShortcutChord();
      window.removeEventListener('keydown', onTerminalCaptureKeyDown, true);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  createEffect(() => {
    if (!sessionSidebarOpen() || !shellSplitRef) return;
    const clampWidth = () => sessionSidebar.setClampedSize(sessionSidebar.size());
    const observer = new ResizeObserver(clampWidth);
    observer.observe(shellSplitRef);
    window.addEventListener('resize', clampWidth);
    queueMicrotask(clampWidth);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', clampWidth);
    });
  });

  createEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const update = () => setSystemThemeMode(media.matches ? 'dark' : 'light');
    update();
    media.addEventListener('change', update);
    onCleanup(() => media.removeEventListener('change', update));
  });

  createEffect(() => {
    const mode = themeMode();
    const resolvedMode = resolvedThemeMode();
    document.documentElement.classList.toggle('dark', resolvedMode === 'dark');
    document.documentElement.dataset.theme = resolvedMode;
    if (mode === 'system') localStorage.removeItem(THEME_MODE_KEY);
    else localStorage.setItem(THEME_MODE_KEY, mode);
  });

  createEffect(() => {
    document.title = browserTabName().trim() || DEFAULT_APP_TITLE;
  });

  createEffect(() => {
    updateFaviconStatus(faviconStatus());
  });

  createEffect(() => {
    const currentProjects = projects.data?.projects;
    if (!currentProjects?.length) return;
    const currentProjectId = projectId();
    if (currentProjectId && currentProjects.some((project) => project.id === currentProjectId)) return;
    const activePath = initialActiveProjectPath ?? readActiveProjectPath();
    const activePathProject = currentProjects.find((project) => project.path === activePath);
    if (activePath && !activePathProject && !restoredOpenProjects()) return;
    setProjectId(activePathProject?.id ?? currentProjects[0].id);
  });

  createEffect(() => {
    const project = activeProject();
    if (!project) return;
    if (!projectId() && initialActiveProjectPath && project.path !== initialActiveProjectPath && !restoredOpenProjects()) return;
    writeActiveProjectPath(project.path);
  });

  createEffect(() => {
    writeActiveSessionId(activeSessionId());
  });

  createEffect(() => {
    if (pendingActiveWorkspacePath()) return;
    const workspaceId = workspaceProject()?.id;
    const id = activeSessionId();
    if (workspaceId && id && sessionWorkspaceId() === workspaceId) rememberWorkspaceSession(workspaceId, id);
  });

  createEffect(() => {
    const query = chatSearchInput();
    const timeout = window.setTimeout(() => setChatSearchQuery(query), CHAT_SEARCH_DEBOUNCE_MS);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    const project = activeProject();
    const workspacePath = pendingActiveWorkspacePath();
    if (!project || !workspacePath) return;
    if (workspacePath === project.path) {
      setPendingActiveWorkspacePath(undefined);
      return;
    }
    if (workspacesEnabledByPath()[project.path]) return;
    setWorkspacesEnabledByPath((current) => {
      const next = { ...current, [project.path]: true };
      writeWorkspacesEnabledByPath(next);
      return next;
    });
  });

  createEffect(() => {
    const project = activeProject();
    if (!project) return;
    if (!workspaceModeActive()) {
      if (pendingActiveWorkspacePath() && !workspacesError()) return;
      if (workspaceProjectId() !== project.id) resetWorkspaceSelection(project.id);
      return;
    }
    const listed = projectWorkspaces();
    if (!listed.length) return;
    const workspacePath = pendingActiveWorkspacePath();
    if (workspacePath) {
      const targetWorkspace = listed.find((workspace) => workspace.path === workspacePath);
      setPendingActiveWorkspacePath(undefined);
      if (targetWorkspace) {
        if (workspaceProjectId() !== targetWorkspace.id) resetWorkspaceSelection(targetWorkspace.id);
        return;
      }
    }
    if (listed.some((workspace) => workspace.id === workspaceProjectId())) return;
    resetWorkspaceSelection(listed.find((workspace) => workspace.local)?.id ?? project.id);
  });

  createEffect(() => {
    const project = activeProject();
    const workspace = activeWorkspace();
    if (!project || !workspace || pendingActiveWorkspacePath()) return;
    writeActiveWorkspacePath(project.path, workspace.path);
  });

  createEffect(() => {
    const workspace = activeWorkspace();
    if (!workspace || pendingActiveWorkspacePath()) return;
    if (workspaceModeActive() && workspaceProjectId() !== workspace.id) return;
    const workspaceId = workspace.id;
    if (workspaceSessionRestoredForId === workspaceId) return;
    workspaceSessionRestoredForId = workspaceId;
    if (initialSessionRestorePending && sessionId() === initialActiveSessionId) {
      initialSessionRestorePending = false;
      const restoreRequest = workspaceSessionRestoreRequest + 1;
      workspaceSessionRestoreRequest = restoreRequest;
      setActiveSession(undefined, workspaceId);
      resetAgentEvents([]);
      if (initialActiveSessionId) void restoreRememberedWorkspaceSession(workspaceId, initialActiveSessionId, restoreRequest);
      return;
    }
    initialSessionRestorePending = false;
    const rememberedSessionId = lastWorkspaceSessions()[workspaceId];
    if (activeSessionId() === rememberedSessionId) return;
    const restoreRequest = workspaceSessionRestoreRequest + 1;
    workspaceSessionRestoreRequest = restoreRequest;
    setActiveSession(undefined, workspaceId);
    resetAgentEvents([]);
    if (rememberedSessionId) void restoreRememberedWorkspaceSession(workspaceId, rememberedSessionId, restoreRequest);
    else if (toolPanel() === 'tree') setToolPanel(undefined);
  });

  createEffect(() => {
    const project = activeProject();
    const listed = workspaces.data?.workspaces;
    if (!project || !listed) return;
    setKnownWorkspacesByRootId((current) => ({ ...current, [project.id]: listed.filter((workspace) => workspace.rootProjectId === project.id) }));
  });

  createEffect(() => {
    const projectIds = new Set((projects.data?.projects ?? []).map((project) => project.id));
    setKnownWorkspacesByRootId((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([rootId]) => projectIds.has(rootId)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  });

  createEffect(() => {
    if (auth.data?.authenticated === false || restoredOpenProjects() || restoringOpenProjects() || !projects.data) return;
    setRestoringOpenProjects(true);
    const currentPaths = projects.data.projects.map((project) => project.path);
    const storedOpenPaths = readOpenProjects();
    const missingPaths = storedOpenPaths.filter((projectPath) => !currentPaths.includes(projectPath));
    if (!missingPaths.length) {
      writeProjectPaths(OPEN_PROJECTS_KEY, [...currentPaths, ...storedOpenPaths]);
      setRestoredOpenProjects(true);
      setRestoringOpenProjects(false);
      return;
    }
    void restoreOpenProjects(missingPaths, currentPaths, initialActiveProjectPath ?? readActiveProjectPath(), setProjectId)
      .finally(() => {
        setRestoredOpenProjects(true);
        setRestoringOpenProjects(false);
      });
  });

  createEffect(() => {
    if (!notificationSoundEnabled()) return;
    const unlock = () => void unlockWorkspaceNotificationSound();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    onCleanup(() => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    });
  });

  createEffect(() => {
    const project = workspaceProject();
    const currentActiveSessionId = activeSessionId();
    if (!project) return;
    const socket = new WebSocket(appWebSocketUrl(`/ws/projects/${project.id}/agent${currentActiveSessionId ? `?sessionId=${currentActiveSessionId}` : ''}`));
    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(event.data) as { type?: string; sessionId?: string; data?: unknown };
        const dataType = parsed.type === 'agent:event' ? agentEventDataType(parsed.data) : undefined;
        if (parsed.type === 'agent:start' || dataType === 'agent_start') resetAgentEvents([event.data]);
        else if (shouldShowAgentEvent(event.data)) queueAgentEvent(event.data);
        const eventSessionId = parsed.sessionId ?? currentActiveSessionId;
        if (parsed.type === 'agent:status' && eventSessionId) updateAgentStatusCache(project.id, eventSessionId, parsed.data);
        if ((parsed.type === 'agent:finish' || parsed.type === 'agent:error' || parsed.type === 'bash:finish' || parsed.type === 'bash:error' || dataType === 'agent_end') && eventSessionId) {
          queryClient.invalidateQueries({ queryKey: ['session', project.id, eventSessionId] });
          queryClient.invalidateQueries({ queryKey: ['session-tree', project.id, eventSessionId] });
          queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
          queryClient.invalidateQueries({ queryKey: ['agent-status', project.id, eventSessionId] });
          invalidateProjectFileCaches(project.id);
        }
      } catch {
        if (shouldShowAgentEvent(event.data)) queueAgentEvent(event.data);
      }
    });
    onCleanup(() => socket.close());
  });

  createEffect(() => {
    const project = workspaceProject();
    if (!project) return;
    const socket = new WebSocket(appWebSocketUrl(`/ws/projects/${project.id}/files`));
    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(event.data) as { type?: string };
        if (parsed.type === 'files:change') invalidateProjectFileQueries(project.id);
      } catch {
        // Ignore malformed file watcher events.
      }
    });
    onCleanup(() => socket.close());
  });

  createEffect(() => {
    const ids = Object.keys(workspaceLookup()).sort();
    if (!ids.length) return;
    const sockets = ids.map((workspaceId) => {
      const socket = new WebSocket(appWebSocketUrl(`/ws/projects/${workspaceId}/notifications`));
      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(event.data) as WorkspaceNotificationServerEvent;
          if (parsed.type === 'pong' || parsed.type === 'error') return;
          handleWorkspaceNotificationEvent(workspaceId, parsed);
        } catch {
          // Ignore malformed notification events.
        }
      });
      return socket;
    });
    onCleanup(() => sockets.forEach((socket) => socket.close()));
  });

  createEffect(() => {
    const workspaceId = workspaceProject()?.id;
    const currentActiveSessionId = activeSessionId();
    if (workspaceId && isWorkspaceNotificationViewed(workspaceId, currentActiveSessionId)) markWorkspaceSessionNotificationsRead(workspaceId, currentActiveSessionId);
  });

  createEffect(() => {
    const markActiveRead = () => {
      const workspaceId = workspaceProject()?.id;
      const currentActiveSessionId = activeSessionId();
      if (workspaceId && isWorkspaceNotificationViewed(workspaceId, currentActiveSessionId)) markWorkspaceSessionNotificationsRead(workspaceId, currentActiveSessionId);
    };
    document.addEventListener('visibilitychange', markActiveRead);
    window.addEventListener('focus', markActiveRead);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', markActiveRead);
      window.removeEventListener('focus', markActiveRead);
    });
  });

  async function openProject(projectPath: string, options?: { closeProjectId?: string }) {
    try {
      const { project } = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath.trim() }),
      });
      rememberRecentProject(project.path);
      rememberOpenProject(project.path);
      const closedProject = options?.closeProjectId ? projects.data?.projects.find((item) => item.id === options.closeProjectId) : undefined;
      if (options?.closeProjectId && options.closeProjectId !== project.id) {
        await api(`/api/projects/${options.closeProjectId}`, { method: 'DELETE' });
        if (closedProject) forgetOpenProject(closedProject.path);
      }
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setActiveSession(undefined);
      setProjectId(project.id);
      resetWorkspaceSelection(project.id);
      writeActiveProjectPath(project.path);
      setWorkspaceToolPanel(undefined);
      setOpenProjectModal(false);
    } catch (error) {
      setAppError({ title: 'Could not open project', description: errorMessage(error, 'Could not open project') });
    }
  }

  async function saveProjectEdit(project: Project, input: ProjectEditInput) {
    const projectPath = input.path.trim();
    if (!projectPath) throw new Error('Workspace path is required');

    let nextProject = project;
    if (projectPath !== project.path) {
      const result = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      nextProject = result.project;
    }

    const pathChanged = nextProject.path !== project.path;
    const existingPreference = projectPreference(project);
    let image = !pathChanged && !input.clearImage ? existingPreference.image : undefined;
    if (input.imageFile) {
      const form = new FormData();
      form.append('file', input.imageFile);
      const result = await api<{ uploaded: Array<{ filename: string; path: string; bytes: number }> }>(`/api/projects/${nextProject.id}/uploads`, { method: 'POST', body: form });
      image = result.uploaded[0]?.path;
    }

    const saved = await api<{ project: Project }>(`/api/projects/${nextProject.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: input.color ?? null, image: image ?? null }),
    });
    nextProject = saved.project;

    rememberRecentProject(nextProject.path);
    rememberOpenProject(nextProject.path);
    if (pathChanged && project.id !== nextProject.id) {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      forgetOpenProject(project.path);
    }
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    setActiveSession(undefined);
    setProjectId(nextProject.id);
    resetWorkspaceSelection(nextProject.id);
    writeActiveProjectPath(nextProject.path);
    setWorkspaceToolPanel(undefined);
    setEditingProject(undefined);
  }

  async function closeProject(project: Project) {
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    forgetOpenProject(project.path);
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    if (project.id === projectId()) {
      const nextProject = projects.data?.projects.find((item) => item.id !== project.id);
      setActiveSession(undefined);
      setProjectId(nextProject?.id);
      writeActiveProjectPath(nextProject?.path);
      if (nextProject) resetWorkspaceSelection(nextProject.id);
      else {
        setWorkspaceProjectId(undefined);
        resetAgentEvents([]);
      }
      setWorkspaceToolPanel(undefined);
    }
  }

  function selectProject(id: string) {
    if (id === projectId()) return;
    setActiveSession(undefined);
    setProjectId(id);
    const project = projects.data?.projects.find((item) => item.id === id);
    if (project) writeActiveProjectPath(project.path);
    resetWorkspaceSelection(id);
    setWorkspaceToolPanel(undefined);
  }

  function handleProjectReorder(projectIds: string[]) {
    writeProjectOrder(projectIds);
    queryClient.setQueryData<{ projects: Project[] }>(['projects'], (current) => {
      if (!current) return current;
      const projectMap = new Map(current.projects.map((p) => [p.id, p]));
      const orderedIds = new Set(projectIds);
      const ordered = projectIds.map((id) => projectMap.get(id)).filter((p): p is Project => p !== undefined);
      const remaining = current.projects.filter((p) => !orderedIds.has(p.id));
      return { ...current, projects: [...ordered, ...remaining] };
    });
  }

  function selectSession(id: string, workspaceId = workspaceProject()?.id, expectedSessionId?: string | null) {
    const currentWorkspaceId = workspaceProject()?.id;
    const currentSessionId = activeSessionId();
    if (expectedSessionId !== undefined && currentSessionId !== (expectedSessionId ?? undefined)) return;
    workspaceSessionRestoreRequest += 1;
    const switchedWorkspace = Boolean(workspaceId && currentWorkspaceId !== workspaceId);
    if (workspaceId && currentWorkspaceId !== workspaceId) {
      setActiveSession(undefined, workspaceId);
      setWorkspaceProjectId(workspaceId);
      workspaceSessionRestoredForId = workspaceId;
    }
    if (workspaceId) rememberWorkspaceSession(workspaceId, id);
    if (currentSessionId === id && !switchedWorkspace) return;
    const keepEvents = eventsBelongToSession(events(), id);
    setActiveSession(id, workspaceId);
    if (!keepEvents) resetAgentEvents([]);
  }

  function handleSessionDeleted(id: string) {
    const deletedActiveSession = activeSessionId() === id;
    const deletedPendingRestore = workspaceSessionRestoreTarget?.sessionId === id && workspaceSessionRestoreTarget.request === workspaceSessionRestoreRequest;
    if (deletedActiveSession || deletedPendingRestore) {
      workspaceSessionRestoreRequest += 1;
      if (deletedPendingRestore) workspaceSessionRestoreTarget = undefined;
    }
    forgetLastWorkspaceSessionId(id);
    if (!deletedActiveSession) {
      if (deletedPendingRestore && toolPanel() === 'tree') setToolPanel(undefined);
      return;
    }
    setActiveSession(undefined);
    resetAgentEvents([]);
    if (toolPanel() === 'tree') setToolPanel(undefined);
  }

  function currentSessionName() {
    const project = workspaceProject();
    const id = activeSessionId();
    if (!project || !id) return '';
    const detail = queryClient.getQueryData<SessionDetail>(['session', project.id, id]);
    if (detail) return detail.name ?? '';
    const sessionPages = queryClient.getQueryData<{ pages?: SessionListResponse[] }>(['sessions', project.id]);
    return sessionPages?.pages?.flatMap((page) => page.sessions).find((session) => session.id === id)?.title ?? '';
  }

  async function deleteCurrentSession() {
    const id = activeSessionId();
    const project = workspaceProject();
    if (!id || !project) return;
    if (currentSessionRunning()) {
      setSessionActionError('Session is running. Stop it before deleting.');
      return;
    }
    setSessionActionBusy(true);
    setSessionActionError('');
    try {
      await api<{ ok: true }>(`/api/projects/${project.id}/session?sessionId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSessionDeleteOpen(false);
      handleSessionDeleted(id);
      queryClient.removeQueries({ queryKey: ['session', project.id, id] });
      queryClient.removeQueries({ queryKey: ['session-tree', project.id, id] });
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : 'Could not delete session');
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function renameCurrentSession() {
    const id = activeSessionId();
    const project = workspaceProject();
    if (!id || !project) return;
    setSessionActionBusy(true);
    setSessionActionError('');
    try {
      await api<SessionDetail>(`/api/projects/${project.id}/session/rename?sessionId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ name: renameValue().trim() }), headers: { 'content-type': 'application/json' } });
      setSessionRenameOpen(false);
      setRenameValue('');
      queryClient.invalidateQueries({ queryKey: ['session', project.id, id] });
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : 'Could not rename session');
    } finally {
      setSessionActionBusy(false);
    }
  }

  function currentSessionUrl() {
    const url = new URL(location.href);
    const project = activeProject();
    const workspace = activeWorkspace();
    if (project) url.searchParams.set(PROJECT_QUERY_KEY, encodeProjectPath(project.path));
    if (workspace && project && workspace.path !== project.path) url.searchParams.set(WORKSPACE_QUERY_KEY, encodeProjectPath(workspace.path));
    else url.searchParams.delete(WORKSPACE_QUERY_KEY);
    const id = activeSessionId();
    if (id) url.searchParams.set(SESSION_QUERY_KEY, id);
    else url.searchParams.delete(SESSION_QUERY_KEY);
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  }

  async function shareCurrentSession() {
    try {
      await copyText(currentSessionUrl());
      setShareFeedback(true);
      window.setTimeout(() => {
        setShareFeedback(false);
        setSessionMenuOpen(false);
      }, 1200);
    } catch {
      setSessionMenuOpen(false);
    }
  }

  function startNewSession(workspaceId?: string) {
    const targetWorkspaceId = workspaceId ?? workspaceProject()?.id;
    workspaceSessionRestoreRequest += 1;
    if (targetWorkspaceId) forgetWorkspaceLastSession(targetWorkspaceId);
    setActiveSession(undefined, targetWorkspaceId);
    if (workspaceId) {
      setWorkspaceProjectId(workspaceId);
      workspaceSessionRestoredForId = workspaceId;
    }
    resetAgentEvents([]);
    setToolPanel((panel) => panel === 'tree' ? undefined : panel);
  }

  function resetWorkspaceSelection(id: string) {
    if (initialSessionRestorePending && sessionId() === initialActiveSessionId) {
      const restoreRequest = workspaceSessionRestoreRequest + 1;
      workspaceSessionRestoreRequest = restoreRequest;
      setActiveSession(undefined, id);
      resetAgentEvents([]);
      setWorkspaceProjectId(id);
      workspaceSessionRestoredForId = id;
      initialSessionRestorePending = false;
      if (initialActiveSessionId) void restoreRememberedWorkspaceSession(id, initialActiveSessionId, restoreRequest);
      return;
    }
    const rememberedSessionId = lastWorkspaceSessions()[id];
    const restoreRequest = workspaceSessionRestoreRequest + 1;
    workspaceSessionRestoreRequest = restoreRequest;
    setActiveSession(undefined, id);
    resetAgentEvents([]);
    setWorkspaceProjectId(id);
    workspaceSessionRestoredForId = id;
    if (rememberedSessionId) void restoreRememberedWorkspaceSession(id, rememberedSessionId, restoreRequest);
    else setToolPanel((panel) => panel === 'tree' ? undefined : panel);
  }

  function selectWorkspace(id: string) {
    if (id === workspaceProjectId()) return;
    resetWorkspaceSelection(id);
  }

  async function toggleWorkspaces(project: Project) {
    const enabled = Boolean(workspacesEnabledByPath()[project.path]);
    if (!enabled) {
      try {
        await api<{ workspaces: ProjectWorkspace[] }>(`/api/projects/${project.id}/workspaces`);
      } catch (error) {
        setAppError({ title: 'Could not enable workspaces', description: errorMessage(error, 'Could not enable workspaces') });
        return;
      }
    }

    setWorkspacesEnabledByPath((current) => {
      const next = { ...current, [project.path]: !enabled };
      if (enabled) delete next[project.path];
      writeWorkspacesEnabledByPath(next);
      return next;
    });
    if (project.id === activeProject()?.id) {
      resetWorkspaceSelection(project.id);
      if (!enabled) await queryClient.invalidateQueries({ queryKey: ['workspaces', project.id] });
    }
  }

  async function createWorkspace() {
    const project = activeProject();
    if (!project) return;
    try {
      const { workspace } = await api<{ workspace: ProjectWorkspace }>(`/api/projects/${project.id}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      await queryClient.invalidateQueries({ queryKey: ['workspaces', project.id] });
      resetWorkspaceSelection(workspace.id);
    } catch (error) {
      setAppError({ title: 'Could not create workspace', description: errorMessage(error, 'Could not create workspace') });
    }
  }

  async function deleteWorkspace(workspace: ProjectWorkspace, options?: { force?: boolean }) {
    const project = activeProject();
    if (!project || workspace.local) return;
    await api(`/api/projects/${project.id}/workspaces/${workspace.id}${options?.force ? '?force=true' : ''}`, { method: 'DELETE' });
    queryClient.removeQueries({ queryKey: ['sessions', workspace.id] });
    queryClient.removeQueries({ queryKey: ['session-tree', workspace.id] });
    queryClient.removeQueries({ queryKey: ['settings', workspace.id] });
    queryClient.removeQueries({ queryKey: ['settings-editor', workspace.id] });
    queryClient.removeQueries({ queryKey: ['git-status', workspace.id] });
    queryClient.removeQueries({ queryKey: ['git-file-diff', workspace.id] });
    forgetWorkspaceLastSession(workspace.id);
    await queryClient.invalidateQueries({ queryKey: ['workspaces', project.id] });
    if (workspaceProjectId() === workspace.id) resetWorkspaceSelection(project.id);
  }

  function setSessionSidebar(open: boolean) {
    setSessionSidebarOpen(open);
    localStorage.setItem(SESSION_SIDEBAR_OPEN_KEY, String(open));
  }

  function toggleSessionSidebar() {
    setSessionSidebar(!sessionSidebarOpen());
  }

  function setWorkspaceToolPanel(panel?: ToolPanel) {
    const currentPanel = toolPanel();
    if (panel !== 'files' || currentPanel !== 'files') setFileSearchRequest(0);
    if (currentPanel === 'review' && panel !== 'review') {
      const initialSidebarOpen = reviewInitialSessionSidebarOpen();
      setToolPanel(panel);
      setReviewInitialSessionSidebarOpen(undefined);
      if (initialSidebarOpen !== undefined) setSessionSidebar(initialSidebarOpen);
      return;
    }
    if (currentPanel !== 'review' && panel === 'review') {
      setReviewInitialSessionSidebarOpen(sessionSidebarOpen());
      if (sessionSidebarOpen()) setSessionSidebarOpen(false);
    }
    setToolPanel(panel);
  }

  function navigateChatSearch(direction: 1 | -1) {
    setChatSearchQuery(chatSearchInput());
    setChatSearchRequest((request) => ({ seq: request.seq + 1, direction }));
  }

  function clearChatSearch() {
    setChatSearchInput('');
    setChatSearchQuery('');
    setChatSearchState({ activeIndex: 0, total: 0 });
  }

  function toggleShortcutToolPanel(panel: ToolPanel) {
    if (!workspaceProject()) return false;
    if (panel === 'tree' && !activeSessionId()) return false;
    setWorkspaceToolPanel(toolPanel() === panel ? undefined : panel);
    return true;
  }

  function openFileSearchFromShortcut() {
    if (!workspaceProject()) return false;
    setWorkspaceToolPanel('files');
    setFileSearchRequest((request) => request + 1);
    return true;
  }

  function selectShortcutWorkspace(index: number) {
    if (index < 0) return false;
    if (workspaceModeActive()) {
      const workspace = projectWorkspaces()[index];
      if (!workspace) return false;
      selectWorkspace(workspace.id);
      return true;
    }
    const project = orderedProjects()[index];
    if (!project) return false;
    selectProject(project.id);
    return true;
  }

  function focusChatSearch() {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(CHAT_SEARCH_INPUT_SELECTOR);
      input?.focus();
      input?.select();
    });
  }

  function toggleThemeMode() {
    setThemeMode(resolvedThemeMode() === 'dark' ? 'light' : 'dark');
  }

  if (auth.data?.required && !auth.data.authenticated) return <Login onDone={() => queryClient.invalidateQueries({ queryKey: ['auth'] })} />;

  return (
    <div class="h-screen overflow-hidden bg-background text-foreground">
      <div ref={shellSplitRef} class={`shell-split grid h-full ${sessionSidebarOpen() ? 'bg-sidebar' : 'bg-background'}`} style={{ 'grid-template-columns': sessionSidebarOpen() ? `${PROJECT_RAIL_WIDTH}px ${sessionSidebar.size()}px minmax(0, 1fr)` : `${PROJECT_RAIL_WIDTH}px minmax(0, 1fr)` }}>
        <div class="max-md:hidden">
          <ProjectRail projects={orderedProjects()} activeProjectId={activeProject()?.id} projectNotifications={projectNotificationSummaries()} sessionSidebarOpen={sessionSidebarOpen()} shortcutsEnabled={!workspaceModeActive()} onProject={selectProject} onProjectMenu={setProjectMenu} onAddProject={() => setOpenProjectModal(true)} onSettings={() => setSettingsOpen(true)} onReorder={handleProjectReorder} />
        </div>
        <Show when={sessionSidebarOpen()}>
          <Sidebar
            project={activeProject()}
            workspaceProject={workspaceProject()}
            workspacesEnabled={workspaceModeActive()}
            workspacesError={workspacesError()}
            workspaces={projectWorkspaces()}
            workspacesLoading={workspaces.isLoading}
            selectedWorkspaceId={activeWorkspace()?.id}
            selectedSessionId={activeSessionId()}
            workspaceNotifications={workspaceNotificationSummaries()}
            onWorkspace={selectWorkspace}
            onSession={selectSession}
            onNewSession={startNewSession}
            onDeleteSession={handleSessionDeleted}
            onProjectMenu={setProjectMenu}
            onToggleSidebar={toggleSessionSidebar}
            resizing={sessionSidebar.resizing()}
            width={sessionSidebar.size()}
            maxWidth={sessionSidebar.maxSize()}
            onResizeStart={sessionSidebar.startResize}
            onResizeKeyDown={sessionSidebar.resizeWithKeyboard}
            onResizeReset={() => sessionSidebar.setClampedSize(SESSION_SIDEBAR_DEFAULT_WIDTH)}
            onDisableWorkspaces={() => activeProject() && void toggleWorkspaces(activeProject()!)}
            onCreateWorkspace={createWorkspace}
            onDeleteWorkspace={deleteWorkspace}
            onOpenNotifications={toggleWorkspaceNotifications}
            onClearNotifications={clearWorkspaceNotifications}
          />
        </Show>
        <main class={`relative min-h-0 min-w-0 overflow-hidden bg-background ${sessionSidebarOpen() ? 'rounded-l-2xl max-md:rounded-none' : ''}`}>
          <Topbar project={workspaceProject()} sessionId={activeSessionId()} sessionSidebarOpen={sessionSidebarOpen()} searchQuery={chatSearchInput()} searchState={chatSearchState()} notificationSummary={workspaceProject() ? workspaceNotificationSummaries()[workspaceProject()!.id] : undefined} menuOpen={sessionMenuOpen()} shareFeedback={shareFeedback()} sessionRunning={currentSessionRunning()} onSearchQuery={setChatSearchInput} onSearchNavigate={navigateChatSearch} onSearchClear={clearChatSearch} onToggleSidebar={toggleSessionSidebar} onOpenNotifications={() => workspaceProject() && toggleWorkspaceNotifications(workspaceProject()!.id)} onMenuOpen={() => setSessionMenuOpen(true)} onMenuClose={() => setSessionMenuOpen(false)} onRename={() => { setRenameValue(currentSessionName()); setSessionActionError(''); setSessionRenameOpen(true); }} onDelete={() => { setSessionActionError(currentSessionRunning() ? 'Session is running. Stop it before deleting.' : ''); setSessionDeleteOpen(true); }} onShare={shareCurrentSession} toolPanel={toolPanel()} setToolPanel={setWorkspaceToolPanel} onMobileMenu={() => setMobileMenuOpen(true)} onMobileToolPopover={() => setMobileToolPopover((v) => !v)} />
          <WorkspaceMain project={workspaceProject()} sessionId={activeSessionId()} events={events()} toolPanel={toolPanel()} themeMode={resolvedThemeMode()} contrastUserMessages={contrastUserMessages()} searchQuery={chatSearchQuery()} searchRequest={chatSearchRequest()} fileSearchRequest={fileSearchRequest()} onSearchState={setChatSearchState} onSession={selectSession} onClosePanel={() => setWorkspaceToolPanel(undefined)} />
        </main>
      </div>
      <Show when={openProjectModal()}>
        <OpenProjectModal projects={projects.data?.projects ?? []} onOpen={openProject} onClose={() => setOpenProjectModal(false)} />
      </Show>
      <Show when={settingsOpen() && activeProject()}>
        {(project) => (
          <SettingsModal
            project={project()}
            themeMode={themeMode()}
            browserTabName={browserTabName()}
            contrastUserMessages={contrastUserMessages()}
            notificationSoundEnabled={notificationSoundEnabled()}
            notificationSoundId={notificationSoundId()}
            notificationSoundVolume={notificationSoundVolume()}
            onThemeMode={setThemeMode}
            onBrowserTabName={setBrowserTabNamePreference}
            onContrastUserMessages={setContrastUserMessagePreference}
            onNotificationSoundEnabled={setNotificationSound}
            onNotificationSound={setNotificationSoundChoice}
            onNotificationSoundVolume={setNotificationSoundVolumePreference}
            onPreviewNotificationSound={previewNotificationSound}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </Show>
      <Show when={editingProject()}>
        {(project) => (
          <ProjectEditModal
            project={project()}
            preference={projectPreference(project())}
            onSave={(input) => saveProjectEdit(project(), input)}
            onClose={() => setEditingProject(undefined)}
          />
        )}
      </Show>
      <Show when={projectMenu()}>
        {(menu) => (
          <ProjectMenu
            menu={menu()}
            workspacesEnabled={Boolean(workspacesEnabledByPath()[menu().project.path])}
            notificationCount={projectNotificationSummaries()[menu().project.id]?.total ?? 0}
            onEdit={(project) => { setProjectMenu(undefined); setEditingProject(project); }}
            onToggleWorkspaces={(project) => { setProjectMenu(undefined); void toggleWorkspaces(project); }}
            onClearNotifications={(project) => { setProjectMenu(undefined); clearProjectNotifications(project); }}
            onCloseProject={(project) => { setProjectMenu(undefined); closeProject(project); }}
            onDismiss={() => setProjectMenu(undefined)}
          />
        )}
      </Show>
      <NotificationToasts toasts={notificationToasts()} workspaces={workspaceLookup()} onOpen={openWorkspaceNotification} onDismiss={removeNotificationToast} />
      <Show when={notificationPanelWorkspace()}>
        {(workspace) => (
          <NotificationPanel
            workspace={workspace()}
            state={workspaceNotificationState(workspaceNotificationStore()[workspace().workspace.id])}
            browserEnabled={browserNotificationsEnabled()}
            soundEnabled={notificationSoundEnabled()}
            onEnableBrowserNotifications={enableBrowserNotifications}
            onSound={setNotificationSound}
            onOpenNotification={openWorkspaceNotification}
            onMarkRead={() => markWorkspaceNotificationsRead(workspace().workspace.id)}
            onClear={() => clearWorkspaceNotifications(workspace().workspace.id)}
            onClose={() => setNotificationPanelWorkspaceId(undefined)}
          />
        )}
      </Show>
      <Show when={appError()}>
        {(error) => <NoticeDialog title={error().title} description={error().description} onClose={() => setAppError(undefined)} />}
      </Show>
      <Show when={sessionRenameOpen()}>
        <PromptDialog
          title="Rename session"
          defaultValue={renameValue()}
          confirmLabel="Rename"
          busyLabel="Renaming..."
          busy={sessionActionBusy()}
          error={sessionActionError()}
          onCancel={() => { setSessionRenameOpen(false); setSessionActionError(''); setRenameValue(''); }}
          onConfirm={(value) => { setRenameValue(value); void renameCurrentSession(); }}
        />
      </Show>
      <Show when={sessionDeleteOpen()}>
        <ConfirmDialog
          title="Delete session?"
          description="This will permanently delete the current session and its transcript. This cannot be undone."
          confirmLabel="Delete"
          busyLabel="Deleting..."
          variant="danger"
          busy={sessionActionBusy()}
          confirmDisabled={currentSessionRunning()}
          error={sessionActionError()}
          onCancel={() => { setSessionDeleteOpen(false); setSessionActionError(''); }}
          onConfirm={() => void deleteCurrentSession()}
        />
      </Show>
      <Show when={mobileMenuOpen()}>
        <MobileMenu
          project={activeProject()}
          workspaceProject={workspaceProject()}
          projects={orderedProjects()}
          workspacesEnabled={workspaceModeActive()}
          workspacesConfigured={workspacesEnabled()}
          workspaces={projectWorkspaces()}
          workspacesLoading={workspaces.isLoading}
          workspacesError={workspacesError()}
          selectedWorkspaceId={activeWorkspace()?.id}
          selectedSessionId={activeSessionId()}
          selectedSessionTitle={currentSessionName()}
          workspaceNotifications={workspaceNotificationSummaries()}
          sessionRunning={currentSessionRunning()}
          onProject={selectProject}
          onWorkspace={selectWorkspace}
          onSession={selectSession}
          onNewSession={startNewSession}
          onDeleteSession={handleSessionDeleted}
          onToggleWorkspaces={() => activeProject() && void toggleWorkspaces(activeProject()!)}
          onCreateWorkspace={createWorkspace}
          onDeleteWorkspace={deleteWorkspace}
          onOpenNotifications={toggleWorkspaceNotifications}
          onClearNotifications={clearWorkspaceNotifications}
          onClearProjectNotifications={() => activeProject() && clearProjectNotifications(activeProject()!)}
          onAddProject={() => setOpenProjectModal(true)}
          onSettings={() => setSettingsOpen(true)}
          onRename={() => { setRenameValue(currentSessionName()); setSessionActionError(''); setSessionRenameOpen(true); }}
          onDelete={() => { setSessionActionError(currentSessionRunning() ? 'Session is running. Stop it before deleting.' : ''); setSessionDeleteOpen(true); }}
          onShare={shareCurrentSession}
          onToolPanel={setWorkspaceToolPanel}
          onClose={() => setMobileMenuOpen(false)}
          onEdit={() => { setMobileMenuOpen(false); activeProject() && setEditingProject(activeProject()!); }}
          onCloseProject={() => { setMobileMenuOpen(false); activeProject() && closeProject(activeProject()!); }}
          notificationCount={activeProject() ? (projectNotificationSummaries()[activeProject()!.id]?.total ?? 0) : 0}
        />
      </Show>
      <Show when={mobileToolPopover()}>
        <MobileToolPopover
          toolPanel={toolPanel()}
          sessionId={activeSessionId()}
          setToolPanel={setWorkspaceToolPanel}
          onClose={() => setMobileToolPopover(false)}
        />
      </Show>
    </div>
  );
}

function Login(props: { onDone: () => void }) {
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError('');
    const response = await fetch(appUrl('/api/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password() }) });
    if (response.ok) props.onDone();
    else setError('Invalid password');
  }
  return (
    <div class="grid h-screen place-items-center bg-background p-6 text-foreground">
      <form onSubmit={submit} class="w-full max-w-sm rounded-2xl bg-card p-6 ring-1 ring-foreground/10">
        <div class="mb-5 flex h-10 w-10 items-center justify-center rounded-4xl bg-primary text-lg font-medium text-primary-foreground">π</div>
        <h1 class="mb-1 text-base font-medium leading-none">Welcome back</h1>
        <p class="mb-5 text-sm text-muted-foreground">Enter the Pi Web server password to continue.</p>
        <input class="input" type="password" placeholder="Password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus />
        <Show when={error()}><p class="mt-2 text-sm text-destructive">{error()}</p></Show>
        <button class="button mt-4 w-full" type="submit">Login</button>
      </form>
    </div>
  );
}

function ProjectRail(props: { projects: Project[]; activeProjectId?: string; projectNotifications: Record<string, WorkspaceNotificationSummary>; sessionSidebarOpen: boolean; shortcutsEnabled: boolean; onProject: (id: string) => void; onProjectMenu: (menu: ProjectMenuState) => void; onAddProject: () => void; onSettings: () => void; onReorder?: (projectIds: string[]) => void }) {
  const hintsModifier = () => false;
  let workspacesRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!workspacesRef || !props.onReorder) return;
    const sortable = Sortable.create(workspacesRef, {
      animation: 150,
      delay: 100,
      draggable: '.project-tile',
      setData: setProjectTileDragData,
      onEnd: (event) => {
        if (event.oldIndex === event.newIndex) return;
        const newOrder = sortable.toArray();
        sortable.sort(props.projects.map((project) => project.id), false);
        props.onReorder?.(newOrder);
      },
    });
    onCleanup(() => sortable.destroy());
  });

  return (
    <aside class={`project-rail-shell ${props.sessionSidebarOpen ? '' : 'project-rail-shell-sidebar-hidden'}`}>
      <div class="project-rail-panel">
        <div class="project-rail-workspaces-container">
          <div ref={workspacesRef} class="project-rail-workspaces">
            <For each={props.projects}>
              {(project, index) => {
                const preference = () => projectPreference(project);
                const shortcut = () => workspaceShortcutLabel(index());
                const shortcutTitle = () => props.shortcutsEnabled && shortcut() ? `\nShortcut: ${formatBindingStep('ctrl')} + . then ${shortcut()}` : '';
                return (
                  <button
                    data-id={project.id}
                    class={`project-tile ${props.activeProjectId === project.id ? 'project-tile-active' : ''}`}
                    style={projectColorStyle(project, preference())}
                    title={`${project.name}\n${project.path}${shortcutTitle()}`}
                    onPointerDown={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      event.currentTarget.dataset.dragOffsetX = String(event.clientX - rect.left);
                      event.currentTarget.dataset.dragOffsetY = String(event.clientY - rect.top);
                    }}
                    onClick={() => props.onProject(project.id)}
                    onContextMenu={(event) => { event.preventDefault(); props.onProjectMenu({ project, x: event.clientX, y: event.clientY }); }}
                  >
                    <ProjectAvatarContent project={project} preference={preference()} />
                    <Show when={props.shortcutsEnabled && hintsModifier() && shortcut()}>
                      {(key) => <span class="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary font-mono text-[10px] font-bold leading-none text-primary-foreground ring-2 ring-background">{key()}</span>}
                    </Show>
                    <ProjectNotificationBadge summary={props.projectNotifications[project.id]} />
                  </button>
                );
              }}
            </For>
          </div>
          <button class="project-add" title="Open project" onClick={props.onAddProject}><Plus class="size-5" /></button>
        </div>
        <div class="project-rail-settings">
          <button class="rail" title={`Pi settings (${formatBinding(getShortcutBinding('openSettings'))})`} onClick={props.onSettings}><Settings class="size-5" /></button>
        </div>
      </div>
    </aside>
  );
}

function ProjectNotificationBadge(props: { summary?: WorkspaceNotificationSummary }) {
  const summary = () => props.summary;
  return (
    <Show when={summary() && (summary()!.unread || summary()!.running || summary()!.error)}>
      <span class={`project-notification-badge ${summary()!.error ? 'project-notification-badge-error' : summary()!.running ? 'project-notification-badge-running' : ''}`}>
        <Show when={summary()!.unread} fallback={<span class="project-notification-pulse" />}>
          {(unread) => <span>{unread() > 9 ? '9+' : unread()}</span>}
        </Show>
      </span>
    </Show>
  );
}

function ProjectMenu(props: {
  menu: ProjectMenuState;
  workspacesEnabled: boolean;
  notificationCount: number;
  onEdit: (project: Project) => void;
  onToggleWorkspaces: (project: Project) => void;
  onClearNotifications: (project: Project) => void;
  onCloseProject: (project: Project) => void;
  onDismiss: () => void;
}) {
  createEffect(() => {
    const dismiss = () => props.onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onDismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <div class="project-menu" style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }} onMouseDown={(event) => event.stopPropagation()}>
      <button class="project-menu-item" onClick={() => props.onEdit(props.menu.project)}>Edit</button>
      <button class="project-menu-item" onClick={() => props.onToggleWorkspaces(props.menu.project)}>{props.workspacesEnabled ? 'Disable workspaces' : 'Enable workspaces'}</button>
      <button class={`project-menu-item ${props.notificationCount ? '' : 'project-menu-item-disabled'}`} disabled={!props.notificationCount} onClick={() => props.onClearNotifications(props.menu.project)}>Clear notifications{props.notificationCount ? ` (${props.notificationCount})` : ''}</button>
      <div class="project-menu-divider" />
      <button class="project-menu-item" onClick={() => props.onCloseProject(props.menu.project)}>Close</button>
    </div>
  );
}

function ProjectEditModal(props: { project: Project; preference: ProjectPreference; onSave: (input: ProjectEditInput) => void | Promise<void>; onClose: () => void }) {
  const [projectPath, setProjectPath] = createSignal(props.project.path);
  const [color, setColor] = createSignal<ProjectColorId | ''>(props.preference.color ?? '');
  const [imageFile, setImageFile] = createSignal<globalThis.File>();
  const [imagePreviewUrl, setImagePreviewUrl] = createSignal<string>();
  const [clearImage, setClearImage] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const pathChanged = createMemo(() => projectPath().trim() !== props.project.path);
  const previewProject = createMemo<Project>(() => ({ ...props.project, name: projectNameFromPath(projectPath().trim() || props.project.path), path: projectPath().trim() || props.project.path }));
  const previewPreference = createMemo<ProjectPreference>(() => ({ color: color() || undefined, image: clearImage() || pathChanged() || imageFile() ? undefined : props.preference.image }));
  const previewImage = createMemo(() => imagePreviewUrl() ?? (!clearImage() && !pathChanged() && props.preference.image ? assetUrl(props.project.id, props.preference.image) : undefined));
  const canClearImage = createMemo(() => Boolean(imageFile() || (!clearImage() && props.preference.image && !pathChanged())));

  createEffect(() => {
    const file = imageFile();
    if (!file) {
      setImagePreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
    onCleanup(() => URL.revokeObjectURL(url));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy()) props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function chooseImage(files: globalThis.FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the workspace avatar.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Choose an image smaller than 5 MB.');
      return;
    }
    setError('');
    setImageFile(file);
    setClearImage(false);
  }

  function removeImage() {
    setImageFile(undefined);
    setClearImage(true);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await props.onSave({ path: projectPath(), color: color() || undefined, imageFile: imageFile(), clearImage: clearImage() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save workspace');
      setBusy(false);
    }
  }

  return (
    <div class="project-modal-backdrop" onMouseDown={() => !busy() && props.onClose()}>
      <form class="project-edit-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-base font-medium leading-none">Edit workspace</h2>
            <p class="text-sm text-muted-foreground">Set the project image and Tailwind color used in the workspace rail.</p>
          </div>
          <button type="button" class="project-modal-close" disabled={busy()} onClick={props.onClose}><X class="size-4" /></button>
        </div>

        <div class="dialog-body">
          <div class="project-edit-preview mb-4">
            <span class="project-edit-avatar" style={projectColorStyle(previewProject(), previewPreference())}>
              <ProjectAvatarContent project={previewProject()} preference={previewPreference()} imageSrc={previewImage()} />
            </span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold">{previewProject().name}</div>
              <div class="truncate text-xs text-muted-foreground">{projectPath().trim() || props.project.path}</div>
            </div>
          </div>

          <label class="settings-field mb-4">
            <span>Workspace path</span>
            <input class="input" value={projectPath()} onInput={(event) => setProjectPath(event.currentTarget.value)} placeholder="/path/to/workspace" autofocus />
          </label>

          <div class="project-edit-section mb-4">
            <div class="mb-3 text-sm font-medium text-muted-foreground">Image</div>
            <div class="flex flex-wrap items-center gap-2">
              <label class="button-secondary cursor-pointer"><FileImage class="size-4" />Upload image<input class="hidden" type="file" accept="image/*" onChange={(event) => { chooseImage(event.currentTarget.files); event.currentTarget.value = ''; }} /></label>
              <button type="button" class="button-secondary" disabled={!canClearImage()} onClick={removeImage}><Trash2 class="size-4" />Remove image</button>
            </div>
            <p class="mt-2 text-xs text-muted-foreground">Images are stored in this workspace under .pi-web uploads.</p>
          </div>

          <div class="project-edit-section">
            <div class="mb-3 text-sm font-medium text-muted-foreground">Color</div>
            <div class="project-color-grid">
              <button type="button" class={`project-color-option ${color() === '' ? 'project-color-option-active' : ''}`} style={projectColorStyle(previewProject(), {})} onClick={() => setColor('')}>
                <span class="project-color-swatch"><Show when={color() === ''}><Check class="size-3" /></Show></span>
                <span class="min-w-0 flex-1 truncate text-left">Auto</span>
              </button>
              <For each={PROJECT_COLORS}>
                {(projectColor) => (
                  <button type="button" class={`project-color-option ${color() === projectColor.id ? 'project-color-option-active' : ''}`} style={projectColorStyleFromColor(projectColor)} onClick={() => setColor(projectColor.id)}>
                    <span class="project-color-swatch"><Show when={color() === projectColor.id}><Check class="size-3" /></Show></span>
                    <span class="min-w-0 flex-1 truncate text-left">{projectColor.label}</span>
                  </button>
                )}
              </For>
            </div>
          </div>

          <Show when={error()}>
            <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{error()}</div>
          </Show>
        </div>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" disabled={busy()} onClick={props.onClose}>Cancel</button>
          <button class="button" disabled={busy()} type="submit">{busy() ? 'Saving...' : 'Save changes'}</button>
        </div>
      </form>
    </div>
  );
}

function OpenProjectModal(props: { title?: string; initialSearch?: string; projects: Project[]; onOpen: (path: string) => void | Promise<void>; onClose: () => void }) {
  const [search, setSearch] = createSignal(props.initialSearch ?? '');
  const [debouncedSearch, setDebouncedSearch] = createSignal(props.initialSearch ?? '');
  const recentProjects = createMemo(() => mergeRecentProjects(props.projects, readRecentProjects()));
  const filteredRecent = createMemo(() => filterProjectFolders(recentProjects(), debouncedSearch()));
  const folders = createQuery(() => ({
    queryKey: ['project-folders', debouncedSearch()],
    queryFn: ({ signal }) => api<{ folders: ProjectFolder[] }>(`/api/projects/folders?query=${encodeURIComponent(debouncedSearch())}`, { signal }),
    staleTime: 60_000,
  }));
  const filteredFolders = createMemo(() => filterProjectFolders(folders.data?.folders ?? [], debouncedSearch()).filter((folder) => !recentProjects().some((project) => project.path === folder.path)));

  createEffect(() => {
    const value = search();
    const timeout = window.setTimeout(() => setDebouncedSearch(value), 250);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = search().trim();
    if (value) props.onOpen(value);
  }

  return (
    <div class="project-modal-backdrop" onMouseDown={props.onClose}>
      <form class="project-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div class="mb-5 flex items-center justify-between gap-4">
          <h2 class="text-base font-medium leading-none">{props.title ?? 'Open project'}</h2>
          <button type="button" class="project-modal-close" onClick={props.onClose}><X class="size-4" /></button>
        </div>
        <div class="project-search">
          <Search class="size-5 text-muted-foreground" />
          <input class="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" placeholder="Search folders" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} autofocus />
        </div>
        <div class="mt-6 min-h-0 overflow-auto pr-1">
          <ProjectFolderSection title="Recent projects" folders={filteredRecent()} onOpen={props.onOpen} />
          <ProjectFolderSection title="Open project" folders={filteredFolders()} onOpen={props.onOpen} />
        </div>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" onClick={props.onClose}>Cancel</button>
          <button class="button" disabled={!search().trim()} type="submit">Open project</button>
        </div>
      </form>
    </div>
  );
}

function SettingsSection(props: { title: string; children: JSX.Element }) {
  return (
    <div class="settings-section">
      <div class="settings-section-title">{props.title}</div>
      <div class="settings-section-stack">{props.children}</div>
    </div>
  );
}

function SettingsToggleRow(props: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div class="settings-toggle-row">
      <div class="settings-toggle-info">
        <span class="settings-toggle-label">{props.label}</span>
        {props.description && <span class="settings-toggle-desc">{props.description}</span>}
      </div>
      <button type="button" class="switch-control" role="switch" aria-checked={props.checked} data-checked={props.checked ? 'true' : 'false'} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}>
        <span class="switch-thumb" />
      </button>
    </div>
  );
}

function Kbd(props: { children: string; class?: string }) {
  return <kbd class={`rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground ring-1 ring-border ${props.class ?? ''}`}>{props.children}</kbd>;
}

function SettingsDivider(props: { label?: string }) {
  return (
    <div class="flex items-center gap-3">
      <div class="h-px flex-1 bg-border" />
      <Show when={props.label}>
        <span class="shrink-0 text-sm font-semibold text-foreground">{props.label}</span>
      </Show>
      <div class="h-px flex-1 bg-border" />
    </div>
  );
}

function SettingsModal(props: {
  project: Project;
  themeMode: ThemeMode;
  browserTabName: string;
  contrastUserMessages: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundId: NotificationSoundId;
  notificationSoundVolume: number;
  onThemeMode: (mode: ThemeMode) => void;
  onBrowserTabName: (name: string) => void;
  onContrastUserMessages: (enabled: boolean) => void;
  onNotificationSoundEnabled: (enabled: boolean) => void;
  onNotificationSound: (sound: NotificationSoundId) => void;
  onNotificationSoundVolume: (volume: number) => void;
  onPreviewNotificationSound: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [scope, setScope] = createSignal<'global' | 'project'>('global');
  const [form, setForm] = createSignal<PiSettings>({});
  const settings = createQuery(() => ({
    queryKey: ['settings-editor', props.project.id],
    queryFn: ({ signal }) => api<PiSettingsResponse>(`/api/projects/${props.project.id}/settings`, { signal }),
    staleTime: SETTINGS_CACHE_STALE_TIME_MS,
  }));
  const models = createQuery(() => ({
    queryKey: ['models', props.project.id],
    queryFn: ({ signal }) => api<{ models: ModelListItem[] }>(`/api/projects/${props.project.id}/agent/models`, { signal }),
    staleTime: 5 * 60_000,
  }));

  createEffect(() => {
    const data = settings.data;
    if (!data) return;
    setForm(scope() === 'project' ? { ...data.project } : { ...data.global });
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function update<K extends keyof PiSettings>(key: K, value: PiSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateNested(key: 'compaction' | 'retry' | 'terminal' | 'images', value: Record<string, unknown>) {
    setForm((current) => ({ ...current, [key]: { ...((current[key] as Record<string, unknown> | undefined) ?? {}), ...value } }));
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const nextSettings = await api<PiSettingsResponse>(`/api/projects/${props.project.id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: scope(), settings: pruneSettings(form()) }),
    });
    queryClient.setQueryData(['settings', props.project.id], nextSettings);
    queryClient.setQueryData(['settings-editor', props.project.id], nextSettings);
    props.onClose();
  }

  const effective = createMemo(() => settings.data?.effective ?? {});
  const settingsModelValue = createMemo(() => defaultModelReference(form()) ?? '');
  const inheritedSettingsModel = createMemo(() => scope() === 'project' ? defaultModelReference(settings.data?.global) : undefined);
  const selectedSettingsModel = createMemo(() => settingsModelValue() || inheritedSettingsModel() || defaultModelReference(effective()));
  const settingsModelOptions = createMemo(() => settingsDefaultModelOptions(scope(), inheritedSettingsModel(), models.data?.models ?? [], settingsModelValue()));
  const settingsThinkingOptions = createMemo(() => settingsThinkingLevelOptions(scope(), scope() === 'project' ? settings.data?.global.defaultThinkingLevel : undefined, modelThinkingLevels(models.data?.models ?? [], selectedSettingsModel()), form().defaultThinkingLevel));

  function updateDefaultModel(reference: string) {
    setForm((current) => {
      if (!reference) return { ...current, defaultProvider: undefined, defaultModel: undefined };
      const parsed = parseModelReference(reference);
      if (!parsed) return current;
      return {
        ...current,
        defaultProvider: parsed.provider,
        defaultModel: parsed.modelId,
      };
    });
  }

  return (
    <div class="project-modal-backdrop" onMouseDown={props.onClose}>
      <div class="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-base font-medium leading-none">Settings</h2>
            <p class="text-sm text-muted-foreground">Configure Pi Web and pi settings for {props.project.name}.</p>
          </div>
          <button type="button" class="project-modal-close" onClick={props.onClose}><X class="size-4" /></button>
        </div>
        <div class="dialog-body">
          <div class="flex flex-col gap-6">
            <div class="flex flex-col gap-4">
              <h3 class="text-sm font-semibold text-foreground">Pi Web settings</h3>
              <SettingsSection title="Appearance">
                <div class="settings-field">
                  <span>App theme</span>
                  <UiSelect class="w-full" value={props.themeMode} onChange={(value) => props.onThemeMode(value === 'dark' || value === 'light' ? value : 'system')} options={APP_THEME_OPTIONS} ariaLabel="App theme" />
                </div>
                <div class="settings-field">
                  <span>Browser tab name</span>
                  <div class="flex gap-2">
                    <input class="input min-w-0 flex-1" value={props.browserTabName} placeholder={DEFAULT_APP_TITLE} maxLength={80} aria-label="Browser tab name" onInput={(event) => props.onBrowserTabName(event.currentTarget.value)} />
                    <button type="button" class="button-secondary h-10 px-3" disabled={!props.browserTabName} onClick={() => props.onBrowserTabName('')}>Reset</button>
                  </div>
                </div>
                <SettingsToggleRow label="Contrasting user messages" description="Use inverted primary bubbles: dark in light theme and light in dark theme." checked={props.contrastUserMessages} onChange={props.onContrastUserMessages} />
                <div class="settings-field"><span>Syntax theme (light)</span><UiSelect class="w-full" value={form().syntaxHighlightThemeLight ?? ''} onChange={(value) => update('syntaxHighlightThemeLight', (value || undefined) as SyntaxHighlightTheme | undefined)} options={SYNTAX_HIGHLIGHT_LIGHT_THEME_OPTIONS} ariaLabel="Light syntax highlight theme" /></div>
                <div class="settings-field"><span>Syntax theme (dark)</span><UiSelect class="w-full" value={form().syntaxHighlightThemeDark ?? ''} onChange={(value) => update('syntaxHighlightThemeDark', (value || undefined) as SyntaxHighlightTheme | undefined)} options={SYNTAX_HIGHLIGHT_DARK_THEME_OPTIONS} ariaLabel="Dark syntax highlight theme" /></div>
              </SettingsSection>
              <SettingsSection title="Notifications">
                <SettingsToggleRow label="Notification sounds" checked={props.notificationSoundEnabled} onChange={props.onNotificationSoundEnabled} />
                <div class="settings-field">
                  <span>Notification sound</span>
                  <div class="flex gap-2">
                    <UiSelect class="min-w-0 flex-1" value={props.notificationSoundId} onChange={(value) => props.onNotificationSound(value as NotificationSoundId)} options={NOTIFICATION_SOUND_OPTIONS} ariaLabel="Notification sound" />
                    <button type="button" class="button-secondary h-10 px-3" onClick={() => void props.onPreviewNotificationSound()}><Volume2 class="size-4" /> Preview</button>
                  </div>
                </div>
                <div class="settings-field">
                  <span>Notification volume</span>
                  <NotificationVolumeControl value={props.notificationSoundVolume} onChange={props.onNotificationSoundVolume} />
                </div>
              </SettingsSection>
              <p class="text-xs text-muted-foreground">Theme, browser tab, user message bubble, and notification changes apply immediately on this browser.</p>
            </div>

            <SettingsDivider label="Pi settings" />

            <div class="flex flex-col gap-4">
              <form onSubmit={save} class="contents" id="settings-form">
                <div class="flex flex-col gap-4">
                  <div class="flex gap-2 rounded-4xl bg-muted p-[3px] text-sm">
                    <button type="button" class={`settings-tab ${scope() === 'global' ? 'settings-tab-active' : ''}`} onClick={() => setScope('global')}>Global</button>
                    <button type="button" class={`settings-tab ${scope() === 'project' ? 'settings-tab-active' : ''}`} onClick={() => setScope('project')}>Project override</button>
                  </div>
                  <SettingsSection title="AI and Model">
                    <div class="settings-field"><span>Default model</span><UiSelect class="w-full" value={settingsModelValue()} onChange={updateDefaultModel} options={settingsModelOptions()} ariaLabel="Default model" disabled={models.isLoading && !models.data} /></div>
                    <div class="settings-field"><span>Thinking level</span><UiSelect class="w-full" value={form().defaultThinkingLevel ?? ''} onChange={(value) => update('defaultThinkingLevel', (value || undefined) as ThinkingLevel | undefined)} options={settingsThinkingOptions()} ariaLabel="Thinking level" /></div>
                  </SettingsSection>

                  <SettingsSection title="Chat and Tree">
                    <SettingsToggleRow label="Hide thinking blocks in chat output" checked={form().hideThinkingBlock ?? (scope() === 'project' ? effective().hideThinkingBlock ?? false : false)} onChange={(checked) => update('hideThinkingBlock', checked)} />
                    <div class="settings-field"><span>Tool output in chat</span><UiSelect class="w-full" value={form().chatToolOutput ?? ''} onChange={(value) => update('chatToolOutput', (value || undefined) as ChatToolOutputMode | undefined)} options={CHAT_TOOL_OUTPUT_OPTIONS} ariaLabel="Tool output in chat" /></div>
                    <div class="settings-field"><span>Tree filter default</span><UiSelect class="w-full" value={form().treeFilterMode ?? ''} onChange={(value) => update('treeFilterMode', (value || undefined) as TreeFilterMode | undefined)} options={[{ value: '', label: 'Inherited' }, ...TREE_FILTER_OPTIONS]} ariaLabel="Tree filter default" /></div>
                  </SettingsSection>
                  <SettingsSection title="Terminal and Media">
                    <SettingsToggleRow label="Show images in terminal" checked={form().terminal?.showImages ?? effective().terminal?.showImages ?? true} onChange={(checked) => updateNested('terminal', { showImages: checked })} />
                    <SettingsToggleRow label="Block images from LLM" checked={form().images?.blockImages ?? false} onChange={(checked) => updateNested('images', { blockImages: checked })} />
                  </SettingsSection>
                  <SettingsSection title="System and Privacy">
                    <SettingsToggleRow label="Quiet startup" checked={form().quietStartup ?? (scope() === 'project' ? effective().quietStartup ?? false : false)} onChange={(checked) => update('quietStartup', checked)} />
                    <div class="settings-field"><span>Enable install telemetry</span><UiSelect class="w-full" value={form().enableInstallTelemetry === undefined ? '' : String(form().enableInstallTelemetry)} onChange={(value) => update('enableInstallTelemetry', value === '' ? undefined : value === 'true')} options={INHERITED_BOOLEAN_OPTIONS} ariaLabel="Enable install telemetry" /></div>
                  </SettingsSection>
                  <SettingsSection title="Reliability">
                    <SettingsToggleRow label="Auto-compaction enabled" checked={form().compaction?.enabled ?? effective().compaction?.enabled ?? true} onChange={(checked) => updateNested('compaction', { enabled: checked })} />
                    <SettingsToggleRow label="Automatic retry enabled" checked={form().retry?.enabled ?? effective().retry?.enabled ?? true} onChange={(checked) => updateNested('retry', { enabled: checked })} />
                  </SettingsSection>
                </div>
              </form>
            </div>

            <SettingsDivider label="Shortcuts" />

            <div class="flex flex-col gap-4">
              <ShortcutsSettingsPanel />
            </div>
          </div>
        </div>
        <div class="dialog-footer justify-between">
          <p class="text-xs text-muted-foreground">Project pi settings are written to .pi/settings.json and override global settings.</p>
          <div class="flex gap-2"><button type="button" class="button-secondary" onClick={props.onClose}>Cancel</button><button class="button" form="settings-form" disabled={settings.isLoading} type="submit">Save settings</button></div>
        </div>
      </div>
    </div>
  );
}

function ShortcutsSettingsPanel() {
  const [query, setQuery] = createSignal('');
  const [recordingId, setRecordingId] = createSignal<string | null>(null);
  const [recordingSteps, setRecordingSteps] = createSignal<string[]>([]);

  const shortcutMatches = (label: string, ...terms: string[]) => {
    const q = query().trim().toLowerCase();
    return !q || [label, ...terms].some((term) => term.toLowerCase().includes(q));
  };
  const showSwitchWorkspaceShortcut = () => shortcutMatches('Switch workspace', 'Ctrl+.', '1..9', 'workspace');
  const workspaceNavigationShortcuts = () => {
    const shortcuts: { id: string; name: string; category: string }[] = [];
    if (showSwitchWorkspaceShortcut()) shortcuts.push({ id: 'switchWorkspace', name: 'Switch workspace', category: 'Workspace' });
    return shortcuts;
  };
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const defs = SHORTCUT_DEFINITIONS;
    const cats = [...new Set(defs.map((d) => d.category))].map((cat) => ({
      name: cat,
      shortcuts: defs.filter((d) => d.category === cat),
    }));
    return cats
      .map((cat) => ({
        ...cat,
        shortcuts: [
          ...cat.shortcuts.filter(
            (s) => s.name.toLowerCase().includes(q) || formatBinding(getShortcutBinding(s.id)).toLowerCase().includes(q)
          ),
          ...(cat.name === 'Workspace' ? workspaceNavigationShortcuts() : []),
        ],
      }))
      .filter((cat) => cat.shortcuts.length > 0);
  });
  const hasShortcutResults = () => filtered().length > 0;

  const shortcutBinding = (id: string) => {
    if (id === 'switchWorkspace') {
      return (
        <div class="flex shrink-0 items-center gap-1">
          <Kbd>{formatBindingStep('ctrl')}</Kbd>
          <span class="text-xs text-muted-foreground">+</span>
          <Kbd>.</Kbd>
          <span class="text-xs text-muted-foreground">then</span>
          <Kbd>1</Kbd>
          <span class="text-xs text-muted-foreground">..</span>
          <Kbd>9</Kbd>
        </div>
      );
    }
    const isRecording = () => recordingId() === id;
    return (
      <button
        type="button"
        class={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ring-1 transition-colors ${isRecording() ? 'bg-primary text-primary-foreground ring-primary' : 'bg-muted text-muted-foreground ring-border hover:bg-accent hover:text-accent-foreground'}`}
        title={isRecording() ? 'Press a second key for a chord. Press Enter or wait to save a single shortcut. Escape cancels, Backspace clears.' : 'Edit shortcut'}
        onClick={() => startRecording(id)}
      >
        {recordingLabel(id)}
      </button>
    );
  };
  const startRecording = (id: string) => {
    setRecordingSteps([]);
    setRecordingId(id);
  };
  const recordingLabel = (id: string) => {
    if (recordingId() !== id) return formatBinding(getShortcutBinding(id));
    const steps = recordingSteps();
    return steps.length ? `${formatBinding(steps.join(' '))} then …` : 'Press keys…';
  };

  createEffect(() => {
    const id = recordingId();
    if (!id) return;
    let saveTimer: number | undefined;
    const clearSaveTimer = () => {
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer);
        saveTimer = undefined;
      }
    };
    const stopRecording = () => {
      clearSaveTimer();
      setRecordingSteps([]);
      setRecordingId(null);
    };
    const saveBinding = (binding: string) => {
      const overrides = readKeybindingOverrides();
      if (binding === (DEFAULT_SHORTCUT_BINDINGS[id] ?? '')) delete overrides[id];
      else overrides[id] = binding;
      writeKeybindingOverrides(overrides);
      stopRecording();
    };
    const saveSteps = (steps: string[]) => saveBinding(steps.join(' '));
    const scheduleSingleStepSave = (steps: string[]) => {
      clearSaveTimer();
      saveTimer = window.setTimeout(() => saveSteps(steps), 1400);
    };
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const key = normalizedShortcutKey(event);
      if (key === 'enter' && recordingSteps().length) {
        saveSteps(recordingSteps());
        return;
      }
      const binding = eventToBinding(event);
      if (binding === undefined) return;
      if (binding === 'cancel') {
        stopRecording();
        return;
      }
      if (binding === '') {
        saveBinding('');
        return;
      }
      const steps = recordingSteps();
      if (!steps.length) {
        const nextSteps = [binding];
        setRecordingSteps(nextSteps);
        scheduleSingleStepSave(nextSteps);
        return;
      }
      saveSteps([steps[0], binding]);
    };
    window.addEventListener('keydown', handler, true);
    onCleanup(() => {
      clearSaveTimer();
      window.removeEventListener('keydown', handler, true);
    });
  });

  return (
    <div class="flex flex-col gap-4">
      <div class="relative">
        <Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          class="input w-full pl-9"
          placeholder="Search shortcuts..."
          aria-label="Search shortcuts"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div class="flex flex-col gap-5">
        <For each={filtered()}>
          {(category) => (
            <div>
              <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{category.name}</div>
              <div class="flex flex-col gap-1">
                <For each={category.shortcuts}>
                  {(shortcut) => (
                    <div class="flex items-center justify-between gap-4 rounded-xl px-3 py-2 hover:bg-muted/50">
                      <span class="text-sm">{shortcut.name}</span>
                      {shortcutBinding(shortcut.id)}
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
        <Show when={!hasShortcutResults()}>
          <div class="py-8 text-center text-sm text-muted-foreground">No shortcuts found.</div>
        </Show>
      </div>
    </div>
  );
}

function ProjectFolderSection(props: { title: string; folders: ProjectFolder[]; onOpen: (path: string) => void }) {
  return (
    <section class="mb-6">
      <div class="mb-2 px-3 text-sm font-semibold text-muted-foreground">{props.title}</div>
      <div class="space-y-1">
        <For each={props.folders}>
          {(folder) => <ProjectFolderRow folder={folder} onOpen={props.onOpen} />}
        </For>
      </div>
    </section>
  );
}

function ProjectFolderRow(props: { folder: ProjectFolder; onOpen: (path: string) => void }) {
  const segments = createMemo(() => splitDisplayPath(props.folder.displayPath));
  return (
    <button type="button" class="project-folder-row" onClick={() => props.onOpen(props.folder.path)}>
      <Folder class="project-folder-icon" />
      <span class="min-w-0 truncate">
        <span class="text-muted-foreground">{segments().prefix}</span><span>{segments().name}</span>
      </span>
    </button>
  );
}

function WorkspaceNotificationButton(props: { summary?: WorkspaceNotificationSummary; onClick: () => void; label?: string }) {
  const summary = () => props.summary;
  const hasActivity = () => Boolean(summary()?.unread || summary()?.running || summary()?.error);
  return (
    <button data-notification-trigger="true" class={`workspace-notification-button ${hasActivity() ? 'workspace-notification-button-active' : ''} ${summary()?.error ? 'workspace-notification-button-error' : ''}`} title={props.label ?? 'Workspace notifications'} onClick={props.onClick}>
      <Bell class="size-3.5" />
      <Show when={summary()?.running}><span class="workspace-notification-live" /></Show>
      <Show when={summary()?.unread}>{(unread) => <span class="workspace-notification-count">{unread() > 9 ? '9+' : unread()}</span>}</Show>
    </button>
  );
}

function Sidebar(props: {
  project?: Project;
  workspaceProject?: Project;
  workspacesEnabled: boolean;
  workspacesError?: string;
  workspaces?: ProjectWorkspace[];
  workspacesLoading: boolean;
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  workspaceNotifications: Record<string, WorkspaceNotificationSummary>;
  onWorkspace: (id: string) => void;
  onSession: (id: string, workspaceId?: string) => void;
  onNewSession: (workspaceId?: string) => void;
  onDeleteSession: (id: string) => void;
  onProjectMenu: (menu: ProjectMenuState) => void;
  onToggleSidebar: () => void;
  resizing: boolean;
  width: number;
  maxWidth: number;
  onResizeStart: (event: PointerEvent) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onResizeReset: () => void;
  onDisableWorkspaces: () => void;
  onCreateWorkspace: () => Promise<void> | void;
  onDeleteWorkspace: (workspace: ProjectWorkspace, options?: { force?: boolean }) => Promise<void> | void;
  onOpenNotifications: (workspaceId: string) => void;
  onClearNotifications: (workspaceId: string) => void;
}) {
  const [sessionToDelete, setSessionToDelete] = createSignal<{ workspaceId: string; session: SessionSummary }>();
  const [workspaceToDelete, setWorkspaceToDelete] = createSignal<ProjectWorkspace>();
  const [busyAction, setBusyAction] = createSignal<string>();
  const [deleteError, setDeleteError] = createSignal('');
  const hintsActive = () => false;
  const headerProject = createMemo(() => props.workspaceProject ?? props.project);
  const workspaceShortcutItems = createMemo(() => (props.workspaces ?? [])
    .map((workspace, index) => ({ workspace, shortcut: workspaceShortcutLabel(index) }))
    .filter((item): item is { workspace: ProjectWorkspace; shortcut: string } => Boolean(item.shortcut)));
  const sessions = createSessionsQuery(() => props.workspaceProject?.id, () => !props.workspacesEnabled);
  const sessionItems = createMemo(() => sessions.data?.pages.flatMap((page) => page.sessions) ?? []);

  createEffect(() => {
    props.project?.id;
    props.workspaceProject?.id;
    setSessionToDelete(undefined);
    setWorkspaceToDelete(undefined);
    setDeleteError('');
  });

  function newSession(workspaceId?: string) {
    const targetId = workspaceId ?? props.workspaceProject?.id;
    if (!targetId) return;
    props.onWorkspace(targetId);
    props.onNewSession(targetId);
  }

  async function deleteSession(workspaceId: string, session: SessionSummary) {
    setBusyAction(`session:${session.id}`);
    setDeleteError('');
    try {
      await api<{ ok: true }>(`/api/projects/${workspaceId}/session?sessionId=${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      setSessionToDelete(undefined);
      props.onDeleteSession(session.id);
      queryClient.removeQueries({ queryKey: ['session', workspaceId, session.id] });
      queryClient.removeQueries({ queryKey: ['session-tree', workspaceId, session.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete session');
    } finally {
      setBusyAction(undefined);
    }
  }

  async function createWorkspace() {
    setBusyAction('workspace:create');
    try {
      await props.onCreateWorkspace();
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteWorkspace(workspace: ProjectWorkspace, options?: { force?: boolean }) {
    setBusyAction(`workspace:${workspace.id}`);
    setDeleteError('');
    try {
      await props.onDeleteWorkspace(workspace, options);
      setWorkspaceToDelete(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete workspace');
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <>
      <aside class="relative flex h-full flex-col overflow-hidden bg-sidebar p-4 max-md:hidden">
        <div
          class="session-sidebar-resize-handle"
          role="separator"
          aria-label="Resize sessions panel"
          aria-orientation="vertical"
          aria-valuemin={SESSION_SIDEBAR_MIN_WIDTH}
          aria-valuemax={props.maxWidth}
          aria-valuenow={props.width}
          tabIndex={0}
          data-dragging={props.resizing ? 'true' : 'false'}
          onDblClick={props.onResizeReset}
          onKeyDown={props.onResizeKeyDown}
          onPointerDown={props.onResizeStart}
        />
        <div class="mb-3 flex items-center gap-2">
          <Show when={headerProject()}>
            {(project) => (
              <span class="project-sidebar-avatar" style={projectColorStyle(project(), projectPreference(project()))}>
                <ProjectAvatarContent project={project()} preference={projectPreference(project())} />
              </span>
            )}
          </Show>
          <div class="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace</div>
          <Show when={headerProject()}>
            {(project) => <WorkspaceNotificationButton summary={props.workspaceNotifications[project().id]} onClick={() => props.onOpenNotifications(project().id)} />}
          </Show>
          <button class="sidebar-toggle" title={`Hide sessions (${formatBinding(getShortcutBinding('toggleSidebar'))})`} onClick={props.onToggleSidebar}><PanelLeftClose class="size-4" /></button>
        </div>
        <div class="mb-5 flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{headerProject()?.name ?? 'Workspace'}</div>
            <div class="truncate text-xs text-muted-foreground">{headerProject()?.path}</div>
          </div>
          <button class="ghost" title="Project options" onClick={(event) => props.project && props.onProjectMenu({ project: props.project, x: event.clientX, y: event.clientY })}><Ellipsis class="size-4" /></button>
        </div>
        <Show
          when={props.workspacesEnabled}
          fallback={(
            <>
              <Show when={props.workspacesError}>
                {(message) => (
                  <div class="mb-4 rounded-2xl bg-destructive/10 p-3 text-sm text-destructive ring-1 ring-destructive/20">
                    <div class="font-medium">Could not load workspaces</div>
                    <div class="mt-1 text-xs leading-5">{message()}</div>
                    <button class="button-danger mt-3 h-8 px-2 text-xs" onClick={props.onDisableWorkspaces}>Disable workspaces</button>
                  </div>
                )}
              </Show>
              <button class="button-secondary mb-5 w-full" title={`New session (${formatBinding(getShortcutBinding('newSession'))})`} onClick={() => newSession()}><SquarePen class="size-4" />New session</button>
              <div class="session-panel-scrollbar min-h-0 flex-1 overflow-auto pr-1">
                <SessionList
                  sessions={sessionItems()}
                  selectedSessionId={props.selectedSessionId}
                  loading={sessions.isLoading}
                  error={sessions.error}
                  hasMore={sessions.hasNextPage}
                  loadingMore={sessions.isFetchingNextPage}
                  onLoadMore={() => { void sessions.fetchNextPage(); }}
                  onSession={(session) => props.onSession(session.id)}
                  onDeleteSession={(session) => { setDeleteError(''); setSessionToDelete({ workspaceId: props.workspaceProject?.id ?? props.project?.id ?? '', session }); }}
                />
              </div>
            </>
          )}
        >
          <div class="mb-4">
            <button class="button-secondary w-full" title="New workspace" disabled={busyAction() === 'workspace:create'} onClick={createWorkspace}><Plus class="size-4" />{busyAction() === 'workspace:create' ? 'Creating...' : 'New workspace'}</button>
          </div>
          <Show when={props.workspacesLoading && !props.workspaces?.length}>
            <div class="mb-3 rounded-2xl bg-card px-3 py-2 text-sm text-muted-foreground ring-1 ring-foreground/10">Loading workspaces...</div>
          </Show>
          <Show when={hintsActive() && workspaceShortcutItems().length}>
            <div class="mb-3 rounded-2xl bg-card p-2 ring-1 ring-foreground/10">
              <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Workspace shortcuts</div>
              <div class="max-h-40 space-y-1 overflow-auto pr-1">
                <For each={workspaceShortcutItems()}>
                  {(item) => (
                    <button class="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground" onClick={() => props.onWorkspace(item.workspace.id)}>
                      <Kbd class="!bg-primary !text-primary-foreground !ring-primary/30">{item.shortcut}</Kbd>
                      <span class="min-w-0 flex-1 truncate font-medium">{item.workspace.local ? 'Local workspace' : item.workspace.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <div class="session-panel-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-1">
            <For each={props.workspaces ?? []}>
              {(workspace, index) => (
                <WorkspaceSessionGroup
                  workspace={workspace}
                  shortcut={workspaceShortcutLabel(index())}
                  hintsActive={hintsActive()}
                  active={props.selectedWorkspaceId === workspace.id}
                  selectedSessionId={props.selectedSessionId}
                  notificationSummary={props.workspaceNotifications[workspace.id]}
                  onSelectWorkspace={() => props.onWorkspace(workspace.id)}
                  onNewSession={() => newSession(workspace.id)}
                  onDeleteWorkspace={() => { setDeleteError(''); setWorkspaceToDelete(workspace); }}
                  onOpenNotifications={() => props.onOpenNotifications(workspace.id)}
                  onClearNotifications={() => props.onClearNotifications(workspace.id)}
                  onDeleteSession={(session) => { setDeleteError(''); setSessionToDelete({ workspaceId: workspace.id, session }); }}
                  onSession={(session) => props.onSession(session.id, workspace.id)}
                />
              )}
            </For>
          </div>
        </Show>
      </aside>
      <Show when={sessionToDelete()}>
        {(target) => (
          <ConfirmDialog
            title="Delete session?"
            description={`This will permanently delete "${target().session.title || 'New session'}" and its transcript. This cannot be undone.`}
            confirmLabel="Delete"
            busyLabel="Deleting..."
            busy={busyAction() === `session:${target().session.id}`}
            error={deleteError()}
            onCancel={() => { setSessionToDelete(undefined); setDeleteError(''); }}
            onConfirm={() => deleteSession(target().workspaceId, target().session)}
          />
        )}
      </Show>
      <Show when={workspaceToDelete()}>
        {(workspace) => (
          <WorkspaceDeleteDialog
            workspace={workspace()}
            busy={busyAction() === `workspace:${workspace().id}`}
            error={deleteError()}
            onCancel={() => { setWorkspaceToDelete(undefined); setDeleteError(''); }}
            onConfirm={(force) => deleteWorkspace(workspace(), { force })}
          />
        )}
      </Show>
    </>
  );
}

function createSessionsQuery(projectId: () => string | undefined, enabled: () => boolean = () => true) {
  return createInfiniteQuery(() => {
    const id = projectId();
    return {
      queryKey: ['sessions', id],
      queryFn: ({ pageParam, signal }) => {
        if (!id) return Promise.resolve({ sessions: [] } satisfies SessionListResponse);
        const params = new URLSearchParams({ limit: String(SESSION_PAGE_SIZE) });
        if (pageParam) params.set('cursor', String(pageParam));
        return api<SessionListResponse>(`/api/projects/${id}/sessions?${params.toString()}`, { signal });
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: SessionListResponse) => lastPage.nextCursor,
      enabled: Boolean(id && enabled()),
    };
  });
}

function SessionList(props: {
  sessions: SessionSummary[];
  selectedSessionId?: string;
  loading?: boolean;
  error?: unknown;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  class?: string;
}) {
  return (
    <Show when={!props.loading} fallback={<div class="px-3 py-2 text-xs text-muted-foreground">Loading sessions...</div>}>
      <div class={`space-y-1 ${props.class ?? ''}`}>
        <Show when={!props.error || props.sessions.length} fallback={<div class="px-3 py-2 text-xs text-destructive">{errorMessage(props.error, 'Could not load sessions')}</div>}>
          <Show when={props.sessions.length} fallback={<div class="px-3 py-2 text-xs text-muted-foreground">No sessions yet</div>}>
            <For each={props.sessions}>
              {(session) => (
                <div class={`session group ${props.selectedSessionId === session.id ? 'session-active' : ''}`}>
                  <button class="min-w-0 flex-1 text-left" onClick={() => props.onSession(session)}>
                    <span class="block truncate">{session.title || 'New session'}</span>
                    <span class="block text-[11px] text-muted-foreground">{new Date(session.updatedAt).toLocaleDateString()} · {session.entryCount}</span>
                  </button>
                  <button class="session-delete" title="Delete session" onClick={() => props.onDeleteSession(session)}><Trash2 class="size-3.5" /></button>
                </div>
              )}
            </For>
          </Show>
          <Show when={props.error && props.sessions.length}>
            <div class="px-3 py-2 text-xs text-destructive">{errorMessage(props.error, 'Could not load more sessions')}</div>
          </Show>
          <Show when={props.hasMore}>
            <button class="session-load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>Load more</button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function WorkspaceDeleteDialog(props: { workspace: ProjectWorkspace; busy?: boolean; error?: string; onCancel: () => void; onConfirm: (force: boolean) => void }) {
  const status = createQuery(() => ({
    queryKey: ['git-status', props.workspace.id, 'delete-check'],
    queryFn: ({ signal }) => api<{ status: GitStatus }>(`/api/projects/${props.workspace.id}/git/status`, { signal }),
    retry: false,
    staleTime: 5_000,
  }));
  const dirtyCount = createMemo(() => status.data?.status.files.length ?? 0);
  const serverReportedDirty = createMemo(() => /uncommitted/i.test(props.error ?? ''));
  const force = createMemo(() => Boolean(status.error || dirtyCount() || serverReportedDirty()));
  const description = createMemo(() => {
    if (status.isLoading || status.isFetching) return `Checking "${props.workspace.name}" for uncommitted changes before deleting...`;
    if (serverReportedDirty()) return `The server found uncommitted changes in "${props.workspace.name}". Deleting will force-remove the worktree and discard those local changes. pi-web will try to clean up the pi-web branch only when Git says it is already merged; otherwise committed work remains on the branch. Sessions are not deleted.`;
    if (status.error) return `Could not verify the git status for "${props.workspace.name}". Deleting anyway will force-remove the worktree and discard local changes. pi-web will try to clean up the pi-web branch only when Git says it is already merged; otherwise committed work remains on the branch. Sessions are not deleted.`;
    if (dirtyCount()) return `"${props.workspace.name}" has ${dirtyCount()} uncommitted ${dirtyCount() === 1 ? 'change' : 'changes'}. Deleting will force-remove the worktree and discard those local changes. pi-web will try to clean up the pi-web branch only when Git says it is already merged; otherwise committed work remains on the branch. Sessions are not deleted.`;
    return `No uncommitted changes found in "${props.workspace.name}". This will remove the git worktree. pi-web will try to clean up the pi-web branch only when Git says it is already merged; otherwise committed work remains on the branch. Sessions are not deleted.`;
  });

  return (
    <ConfirmDialog
      title="Delete workspace?"
      description={description()}
      confirmLabel={status.error ? 'Delete anyway' : dirtyCount() || serverReportedDirty() ? 'Discard and delete' : 'Delete workspace'}
      busyLabel="Deleting..."
      busy={props.busy}
      confirmDisabled={status.isLoading || status.isFetching}
      error={props.error}
      onCancel={props.onCancel}
      onConfirm={() => props.onConfirm(force())}
    />
  );
}

function WorkspaceStatusPill(props: { summary?: WorkspaceNotificationSummary; onOpen: () => void; onClear: () => void }) {
  const summary = () => props.summary;
  return (
    <Show when={summary() && (summary()!.unread || summary()!.running || summary()!.error)}>
      <button
        data-notification-trigger="true"
        class={`workspace-status-pill ${summary()!.error ? 'workspace-status-pill-error' : summary()!.running ? 'workspace-status-pill-running' : ''}`}
        title={summary()!.latest ? `${summary()!.latest!.title}: ${summary()!.latest!.message}` : 'Workspace notifications'}
        onClick={(event) => {
          if (event.altKey) props.onClear();
          else props.onOpen();
        }}
      >
        <Show when={summary()!.running}><span class="workspace-status-dot" /></Show>
        <Show when={summary()!.unread} fallback={<span>{summary()!.running ? 'running' : 'seen'}</span>}>
          {(unread) => <span>{unread() > 9 ? '9+' : unread()}</span>}
        </Show>
      </button>
    </Show>
  );
}

function WorkspaceSessionGroup(props: {
  workspace: ProjectWorkspace;
  shortcut?: string;
  hintsActive?: boolean;
  active: boolean;
  selectedSessionId?: string;
  notificationSummary?: WorkspaceNotificationSummary;
  onSelectWorkspace: () => void;
  onNewSession: () => void;
  onDeleteWorkspace: () => void;
  onOpenNotifications: () => void;
  onClearNotifications: () => void;
  onDeleteSession: (session: SessionSummary) => void;
  onSession: (session: SessionSummary) => void;
}) {
  const sessions = createSessionsQuery(() => props.workspace.id);
  const sessionItems = createMemo(() => sessions.data?.pages.flatMap((page) => page.sessions) ?? []);

  return (
    <section class={`workspace-group ${props.active ? 'workspace-group-active' : ''}`}>
      <div class="workspace-group-header">
        <button class="min-w-0 flex-1 text-left" onClick={props.onSelectWorkspace}>
          <span class="block truncate text-sm font-semibold">{props.workspace.local ? 'Local workspace' : props.workspace.name}</span>
          <span class="block truncate text-[11px] text-muted-foreground">{props.workspace.branch ?? props.workspace.path}</span>
        </button>
        <Show when={props.shortcut}>
          {(shortcut) => (
            <span
              class={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] font-semibold uppercase leading-none transition-colors ${props.hintsActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
              title={`Workspace shortcut: ${formatBindingStep('ctrl')} + . then ${shortcut()}`}
            >
              {shortcut()}
            </span>
          )}
        </Show>
        <WorkspaceStatusPill summary={props.notificationSummary} onOpen={props.onOpenNotifications} onClear={props.onClearNotifications} />
        <button class="workspace-action" title={`New session in workspace (${formatBinding(getShortcutBinding('newSession'))})`} onClick={props.onNewSession}><SquarePen class="size-3.5" /></button>
        <Show when={!props.workspace.local}>
          <button class="workspace-action" title={props.workspace.removable ? 'Delete workspace' : 'Only pi-web workspaces can be deleted'} disabled={!props.workspace.removable} onClick={props.onDeleteWorkspace}><Trash2 class="size-3.5" /></button>
        </Show>
      </div>
      <div class="mt-1">
        <SessionList
          sessions={sessionItems()}
          selectedSessionId={props.selectedSessionId}
          loading={sessions.isLoading}
          error={sessions.error}
          hasMore={sessions.hasNextPage}
          loadingMore={sessions.isFetchingNextPage}
          onLoadMore={() => { void sessions.fetchNextPage(); }}
          onSession={props.onSession}
          onDeleteSession={props.onDeleteSession}
        />
      </div>
    </section>
  );
}

function ConfirmDialog(props: { title: string; description: string; confirmLabel: string; busyLabel?: string; variant?: 'primary' | 'danger'; busy?: boolean; confirmDisabled?: boolean; error?: string; onCancel: () => void; onConfirm: () => void }) {
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !props.busy && props.onCancel()}>
      <div class="confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">{props.title}</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
        <Show when={props.error}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{props.error}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button class="button-secondary" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button class={props.variant === 'primary' ? 'button' : 'button-danger'} disabled={props.busy || props.confirmDisabled} onClick={props.onConfirm}>{props.busy ? props.busyLabel ?? 'Working...' : props.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function NoticeDialog(props: { title: string; description: string; onClose: () => void }) {
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class="confirm-modal-backdrop" onMouseDown={props.onClose}>
      <div class="confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">{props.title}</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
        <div class="dialog-footer justify-end">
          <button class="button" onClick={props.onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog(props: { title: string; description?: string; defaultValue?: string; confirmLabel: string; busyLabel?: string; busy?: boolean; error?: string; onCancel: () => void; onConfirm: (value: string) => void }) {
  const [value, setValue] = createSignal(props.defaultValue ?? '');
  createEffect(() => {
    setValue(props.defaultValue ?? '');
  });
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!props.busy) props.onConfirm(value());
  };
  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !props.busy && props.onCancel()}>
      <form class="confirm-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">{props.title}</h2>
        <Show when={props.description}>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p>
        </Show>
        <input
          class="mt-4 w-full rounded-2xl bg-muted px-3 py-2 text-sm text-foreground outline-none ring-1 ring-foreground/10 transition-colors placeholder:text-muted-foreground focus-visible:ring-ring"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
          placeholder="Session name"
          autofocus
        />
        <Show when={props.error}>
          <div class="mt-3 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{props.error}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button class="button" disabled={props.busy}>{props.busy ? props.busyLabel ?? 'Saving...' : props.confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

function NotificationPanel(props: {
  workspace: WorkspaceLookupEntry;
  state: WorkspaceNotificationState;
  browserEnabled: boolean;
  soundEnabled: boolean;
  onEnableBrowserNotifications: () => void | Promise<void>;
  onSound: (enabled: boolean) => void;
  onOpenNotification: (notification: WorkspaceNotificationItem) => void;
  onMarkRead: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  let panelRef: HTMLElement | undefined;
  const items = createMemo(() => props.state.items);
  const summary = createMemo(() => workspaceNotificationSummary(props.state));
  const browserNotificationsSupported = () => 'Notification' in window;
  const browserPermission = () => browserNotificationsSupported() ? Notification.permission : 'denied';
  const workspaceName = () => workspaceDisplayName(props.workspace.workspace, props.workspace.rootProject);

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-notification-trigger="true"]')) return;
      props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    });
  });

  return (
    <Portal>
      <section ref={panelRef} class="notification-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div class="notification-panel-header">
          <div class="notification-panel-avatar" style={projectColorStyle(props.workspace.project, projectPreference(props.workspace.project))}>
            <ProjectAvatarContent project={props.workspace.project} preference={projectPreference(props.workspace.project)} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">{workspaceName()}</div>
            <div class="truncate text-xs text-muted-foreground">{props.workspace.workspace.branch ?? props.workspace.workspace.path}</div>
          </div>
          <button class="project-modal-close" onClick={props.onClose}><X class="size-4" /></button>
        </div>
        <div class="notification-panel-toolbar">
          <span class="notification-panel-summary">{summary().unread} unread{summary().running ? ` · ${summary().running} running` : ''}{summary().error ? ' · error' : ''}</span>
          <div class="flex-1" />
          <button class="ghost h-8 px-2.5 text-xs" disabled={!summary().unread} onClick={props.onMarkRead}>Mark read</button>
          <button class="ghost h-8 px-2.5 text-xs" disabled={!items().length} onClick={props.onClear}>Clear</button>
          <button class="ghost h-8 px-2.5 text-xs" onClick={() => props.onSound(!props.soundEnabled)} title={props.soundEnabled ? 'Sound on' : 'Sound off'}>{props.soundEnabled ? <Volume2 class="size-4" /> : <VolumeX class="size-4" />}</button>
          <Show when={browserNotificationsSupported() && browserPermission() !== 'denied' && (!props.browserEnabled || browserPermission() !== 'granted')}>
            <button class="ghost h-8 px-2.5 text-xs" onClick={() => void props.onEnableBrowserNotifications()}>Alerts</button>
          </Show>
        </div>
        <div class="notification-list">
          <Show when={items().length} fallback={<div class="notification-empty">No notifications for this workspace yet.</div>}>
            <For each={items()}>
              {(notification) => (
                <button class={`notification-item notification-item-${notification.level} ${notification.read ? '' : 'notification-item-unread'}`} onClick={() => props.onOpenNotification(notification)}>
                  <span class="notification-item-icon">{notificationIcon(notification)}</span>
                  <span class="min-w-0 flex-1 text-left">
                    <span class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 truncate font-medium">{notification.title}</span>
                      <span class="shrink-0 text-[10px] text-muted-foreground">{relativeTime(notification.createdAt)}</span>
                    </span>
                    <span class="mt-0.5 block truncate text-xs text-muted-foreground">{notification.message}</span>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </section>
    </Portal>
  );
}

function NotificationToasts(props: { toasts: WorkspaceNotificationItem[]; workspaces: Record<string, WorkspaceLookupEntry>; onOpen: (notification: WorkspaceNotificationItem) => void; onDismiss: (id: string) => void }) {
  return (
    <Portal>
      <div class="notification-toast-stack">
        <For each={props.toasts}>
          {(notification) => {
            const workspace = () => props.workspaces[notification.workspaceId];
            return (
              <div class={`notification-toast notification-toast-${notification.level}`}>
                <button class="notification-toast-body" onClick={() => props.onOpen(notification)}>
                  <Show when={workspace()}>
                    {(entry) => (
                      <span class="notification-toast-avatar" style={projectColorStyle(entry().project, projectPreference(entry().project))}>
                        <ProjectAvatarContent project={entry().project} preference={projectPreference(entry().project)} />
                      </span>
                    )}
                  </Show>
                  <span class="min-w-0 flex-1 text-left">
                    <span class="block truncate text-xs font-medium text-muted-foreground">{workspace() ? workspaceDisplayName(workspace()!.workspace, workspace()!.rootProject) : 'Workspace'}</span>
                    <span class="block truncate text-sm font-semibold leading-tight">{notification.title}</span>
                    <span class="block truncate text-xs text-muted-foreground">{notification.message}</span>
                  </span>
                </button>
                <button class="notification-toast-close" type="button" title="Dismiss" aria-label="Dismiss" onClick={() => props.onDismiss(notification.id)}><X class="size-4" /></button>
                <div class="notification-toast-progress" />
              </div>
            );
          }}
        </For>
      </div>
    </Portal>
  );
}

function notificationIcon(notification: WorkspaceNotificationItem) {
  if (notification.kind === 'command') return <SquareTerminal class="size-4" />;
  if (notification.kind === 'retry') return <RefreshCw class="size-4" />;
  if (notification.kind === 'compaction') return <Archive class="size-4" />;
  if (notification.level === 'success') return <Check class="size-4" />;
  if (notification.level === 'error') return <X class="size-4" />;
  return <BadgeInfo class="size-4" />;
}

function NotificationVolumeControl(props: { value: number; onChange: (volume: number) => void }) {
  let sliderRef: HTMLDivElement | undefined;
  let activePointerId: number | undefined;
  const percent = createMemo(() => notificationSoundVolumePercent(props.value));
  const volumeLabel = createMemo(() => percent() ? `${percent()}%` : 'Muted');
  const adjustVolume = (delta: number) => props.onChange(clampNotificationSoundVolume(props.value + delta));

  function setVolumeFromClientX(clientX: number) {
    if (!sliderRef) return;
    const rect = sliderRef.getBoundingClientRect();
    if (!rect.width) return;
    props.onChange(clampNotificationSoundVolume((clientX - rect.left) / rect.width));
  }

  function handlePointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    activePointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setVolumeFromClientX(event.clientX);
  }

  function handlePointerMove(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    setVolumeFromClientX(event.clientX);
  }

  function handlePointerUp(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (activePointerId !== event.pointerId) return;
    activePointerId = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleKeyDown(event: KeyboardEvent) {
    const step = event.shiftKey ? NOTIFICATION_SOUND_VOLUME_STEP * 2 : NOTIFICATION_SOUND_VOLUME_STEP;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      adjustVolume(step);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      adjustVolume(-step);
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      adjustVolume(0.1);
      return;
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      adjustVolume(-0.1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      props.onChange(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      props.onChange(1);
    }
  }

  return (
    <div class="notification-volume-control">
      <button type="button" class="notification-volume-step" aria-label="Decrease notification volume" disabled={percent() <= 0} onClick={() => adjustVolume(-NOTIFICATION_SOUND_VOLUME_STEP)}><Minus class="size-3.5" /></button>
      <div
        ref={sliderRef}
        class="notification-volume-slider"
        role="slider"
        tabIndex={0}
        aria-label="Notification volume"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent()}
        aria-valuetext={volumeLabel()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <span class="notification-volume-track">
          <span class="notification-volume-fill" style={{ width: `${percent()}%` }} />
          <span class="notification-volume-thumb" style={{ left: `${percent()}%` }} />
        </span>
      </div>
      <button type="button" class="notification-volume-step" aria-label="Increase notification volume" disabled={percent() >= 100} onClick={() => adjustVolume(NOTIFICATION_SOUND_VOLUME_STEP)}><Plus class="size-3.5" /></button>
      <span class="notification-volume-value">{volumeLabel()}</span>
    </div>
  );
}

function UiSelect(props: { value: string; options: SelectOption[]; onChange: (value: string) => void; placeholder?: JSX.Element; class?: string; triggerClass?: string; contentWidth?: 'trigger' | 'content'; triggerWidth?: 'trigger' | 'content'; ariaLabel?: string; disabled?: boolean; compact?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 0, maxHeight: 260, placement: 'bottom' as 'top' | 'bottom' });
  let triggerRef: HTMLButtonElement | undefined;
  let contentRef: HTMLDivElement | undefined;

  const selected = createMemo(() => props.options.find((option) => option.value === props.value));

  function firstEnabledIndex() {
    const index = props.options.findIndex((option) => !option.disabled);
    return index >= 0 ? index : 0;
  }

  function selectedIndex() {
    const index = props.options.findIndex((option) => option.value === props.value && !option.disabled);
    return index >= 0 ? index : firstEnabledIndex();
  }

  function updatePosition() {
    if (!triggerRef) return;
    const gap = 6;
    const margin = 8;
    const rect = triggerRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const placement = spaceBelow < 180 && spaceAbove > spaceBelow ? 'top' : 'bottom';
    const maxHeight = Math.max(140, Math.min(320, placement === 'top' ? spaceAbove : spaceBelow));
    let naturalWidth = rect.width;
    if (props.contentWidth === 'content' && contentRef) {
      const previousWidth = contentRef.style.width;
      contentRef.style.width = 'max-content';
      naturalWidth = Math.max(rect.width, contentRef.scrollWidth, contentRef.getBoundingClientRect().width);
      contentRef.style.width = previousWidth;
    }
    const width = Math.min(naturalWidth, window.innerWidth - margin * 2);
    setPosition({
      left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
      top: placement === 'top' ? rect.top - gap : rect.bottom + gap,
      width,
      maxHeight,
      placement,
    });
  }

  function openMenu() {
    setActiveIndex(selectedIndex());
    setOpen(true);
    queueMicrotask(updatePosition);
    requestAnimationFrame(updatePosition);
  }

  function chooseOption(option: SelectOption) {
    if (option.disabled) return;
    props.onChange(option.value);
    setOpen(false);
    triggerRef?.focus();
  }

  function moveActive(delta: number) {
    if (!props.options.length) return;
    let next = activeIndex();
    for (let step = 0; step < props.options.length; step += 1) {
      next = (next + delta + props.options.length) % props.options.length;
      if (!props.options[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (open()) event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open()) openMenu();
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open()) openMenu();
      setActiveIndex(event.key === 'Home' ? firstEnabledIndex() : Math.max(props.options.map((option, index) => option.disabled ? -1 : index).reduce((max, index) => Math.max(max, index), -1), 0));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open()) {
        openMenu();
        return;
      }
      const option = props.options[activeIndex()];
      if (option) chooseOption(option);
    }
  }

  createEffect(() => {
    if (!open()) return;
    setActiveIndex(selectedIndex());
    updatePosition();
    requestAnimationFrame(updatePosition);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        setOpen(false);
        return;
      }
      if (triggerRef?.contains(target) || contentRef?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    });
  });

  return (
    <span class={`select-wrap ${props.compact ? 'select-wrap-compact' : ''} ${props.triggerWidth === 'content' ? 'select-wrap-content' : ''} ${props.class ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        class={`select select-trigger ${props.triggerClass ?? ''}`}
        role="combobox"
        aria-expanded={open()}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onClick={() => open() ? setOpen(false) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span class="select-value">{selected()?.label ?? props.placeholder ?? 'Select'}</span>
        <ChevronDown class={`select-chevron transition-transform ${open() ? 'rotate-180' : ''}`} />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={contentRef}
            class={`select-content ${props.compact ? 'select-content-compact' : ''}`}
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              'max-height': `${position().maxHeight}px`,
              transform: position().placement === 'top' ? 'translateY(-100%)' : '',
            }}
            role="listbox"
          >
            <For each={props.options}>
              {(option, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === props.value}
                  disabled={option.disabled}
                  class={`select-item ${activeIndex() === index() ? 'select-item-active' : ''} ${option.value === props.value ? 'select-item-selected' : ''}`}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index())}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseOption(option)}
                >
                  <span class="min-w-0 flex-1 truncate">{option.label}</span>
                  <Show when={option.value === props.value}><Check class="size-4" /></Show>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </span>
  );
}

function SwitchField(props: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" class="settings-check" role="switch" aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}>
      <span class="settings-check-label">{props.label}</span>
      <span class="switch-control" data-checked={props.checked ? 'true' : 'false'}><span class="switch-thumb" /></span>
    </button>
  );
}

function CheckboxControl(props: { checked: boolean; label: string; onChange: (checked: boolean) => void; class?: string; disabled?: boolean }) {
  return (
    <button type="button" class={`checkbox-row ${props.class ?? ''}`} role="checkbox" aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)} data-checked={props.checked ? 'true' : 'false'}>
      <span class="checkbox-box"><Show when={props.checked}><Check class="size-3" /></Show></span>
      <span>{props.label}</span>
    </button>
  );
}

function Collapsible(props: { title: JSX.Element; children: JSX.Element; class?: string; triggerClass?: string; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [uncontrolledOpen, setUncontrolledOpen] = createSignal(Boolean(props.defaultOpen));
  const open = () => props.open ?? uncontrolledOpen();
  const setOpen = (value: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(value);
    props.onOpenChange?.(value);
  };
  return (
    <div class={props.class} data-open={open() ? 'true' : 'false'}>
      <button type="button" class={`collapsible-trigger ${props.triggerClass ?? ''}`} aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronRight class={`collapsible-icon ${open() ? 'collapsible-icon-open' : ''}`} />
        {props.title}
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  );
}

function Topbar(props: { project?: Project; sessionId?: string; sessionSidebarOpen: boolean; searchQuery: string; searchState: ChatSearchState; notificationSummary?: WorkspaceNotificationSummary; menuOpen: boolean; shareFeedback: boolean; sessionRunning: boolean; onSearchQuery: (query: string) => void; onSearchNavigate: (direction: 1 | -1) => void; onSearchClear: () => void; onToggleSidebar: () => void; onOpenNotifications: () => void; onMenuOpen: () => void; onMenuClose: () => void; onRename: () => void; onDelete: () => void; onShare: () => void; toolPanel?: ToolPanel; setToolPanel: (panel?: ToolPanel) => void; onMobileMenu: () => void; onMobileToolPopover: () => void }) {
  const togglePanel = (panel: ToolPanel) => props.setToolPanel(props.toolPanel === panel ? undefined : panel);
  const searchHasQuery = () => Boolean(props.searchQuery.trim());
  let menuButtonRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.menuOpen) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef?.contains(target) || menuButtonRef?.contains(target))) return;
      props.onMenuClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onMenuClose();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <header class="floating-topbar">
      <button class="sidebar-toggle floating-sidebar-toggle shrink-0 md:hidden" title="Menu" onClick={props.onMobileMenu}><AlignJustify class="size-4" /></button>
      <Show when={!props.sessionSidebarOpen}>
        <button class="sidebar-toggle floating-sidebar-toggle max-md:hidden" title={`Show sessions (${formatBinding(getShortcutBinding('toggleSidebar'))})`} onClick={props.onToggleSidebar}><PanelLeftOpen class="size-4" /></button>
      </Show>
      <div class="floating-search-wrap">
        <Search class="floating-search-icon" />
        <input
          class="floating-search"
          role="searchbox"
          aria-label="Search current chat"
          title={`Search current chat (${formatBinding(getShortcutBinding('searchChat'))})`}
          data-chat-search-input="true"
          placeholder={`Search chat${props.project ? ` in ${props.project.name}` : ''}`}
          value={props.searchQuery}
          onInput={(event) => props.onSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              props.onSearchNavigate(event.shiftKey ? -1 : 1);
            }
            if (event.key === 'Escape' && searchHasQuery()) {
              event.preventDefault();
              props.onSearchClear();
            }
          }}
        />
        <Show when={searchHasQuery()}>
          <span class="floating-search-count">{props.searchState.total ? `${props.searchState.activeIndex}/${props.searchState.total}` : 'No results'}</span>
          <button class="floating-search-button" title="Previous match" disabled={!props.searchState.total} onMouseDown={(event) => event.preventDefault()} onClick={() => props.onSearchNavigate(-1)}><ChevronDown class="size-3.5 rotate-180" /></button>
          <button class="floating-search-button" title="Next match" disabled={!props.searchState.total} onMouseDown={(event) => event.preventDefault()} onClick={() => props.onSearchNavigate(1)}><ChevronDown class="size-3.5" /></button>
          <button class="floating-search-button" title="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={props.onSearchClear}><X class="size-3.5" /></button>
        </Show>
      </div>
      <Show when={props.sessionId}>
        <div class="relative max-md:hidden">
          <button ref={menuButtonRef} class={`session-menu-button ${props.menuOpen ? 'text-foreground' : ''}`} title="Session actions" onClick={() => (props.menuOpen ? props.onMenuClose() : props.onMenuOpen())}><Ellipsis class="size-4" /></button>
          <Show when={props.menuOpen}>
            <div ref={menuRef} class="session-menu-dropdown">
              <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onMenuClose(); props.onRename(); }}>
                <span class="size-4"><SquarePen class="size-3.5" /></span>Rename
              </button>
              <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onShare(); }}>
                <span class="size-4"><ExternalLink class="size-3.5" /></span>{props.shareFeedback ? 'Copied!' : 'Share'}
              </button>
              <div class="project-menu-divider" />
              <button class={`project-menu-item flex items-center gap-2 ${props.sessionRunning ? 'project-menu-item-disabled' : 'project-menu-item-danger'}`} disabled={props.sessionRunning} title={props.sessionRunning ? 'Stop the running session before deleting' : 'Delete session'} onClick={() => { props.onMenuClose(); props.onDelete(); }}>
                <span class="size-4"><Trash2 class="size-3.5" /></span>Delete
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <div class="flex-1" />
      <Show when={!props.sessionSidebarOpen && props.project}>
        {(project) => <WorkspaceNotificationButton summary={props.notificationSummary} onClick={props.onOpenNotifications} label={`Notifications for ${project().name}`} />}
      </Show>
      <div class="floating-tool-group hidden lg:flex">
        <button class={`topbar-tool ${props.toolPanel === 'terminal' ? 'topbar-tool-active' : ''}`} title={`Terminal (${formatBinding(getShortcutBinding('toggleTerminal'))})`} onClick={() => togglePanel('terminal')}><SquareTerminal class="size-3.5" />Terminal</button>
        <button class={`topbar-tool ${props.toolPanel === 'tree' ? 'topbar-tool-active' : ''}`} title={props.sessionId ? `Session tree (${formatBinding(getShortcutBinding('toggleTree'))})` : `Select or create a session to use tree (${formatBinding(getShortcutBinding('toggleTree'))})`} disabled={!props.sessionId} onClick={() => props.sessionId && togglePanel('tree')}><GitFork class="size-3.5" />Tree</button>
        <button class={`topbar-tool ${props.toolPanel === 'review' ? 'topbar-tool-active' : ''}`} title={`Review changes (${formatBinding(getShortcutBinding('toggleReview'))})`} onClick={() => togglePanel('review')}><GitCompareArrows class="size-3.5" />Review</button>
        <button class={`topbar-tool ${props.toolPanel === 'files' ? 'topbar-tool-active' : ''}`} title={`File explorer (${formatBinding(getShortcutBinding('toggleFiles'))})`} onClick={() => togglePanel('files')}><Files class="size-3.5" />Files</button>
      </div>
      <button class="session-menu-button lg:hidden" data-mobile-tool-trigger="true" title="Tools" onClick={props.onMobileToolPopover}><Wrench class="size-4" /></button>
    </header>
  );
}

function MobileToolPopover(props: { toolPanel?: ToolPanel; sessionId?: string; setToolPanel: (panel?: ToolPanel) => void; onClose: () => void }) {
  let popoverRef: HTMLDivElement | undefined;
  createEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (popoverRef?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement)?.closest('[data-mobile-tool-trigger]')) return;
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });
  const toggle = (panel: ToolPanel) => {
    props.setToolPanel(props.toolPanel === panel ? undefined : panel);
    props.onClose();
  };
  return (
    <div ref={popoverRef} class="mobile-tool-popover">
      <button class={`project-menu-item flex items-center gap-2 ${props.toolPanel === 'terminal' ? 'bg-accent text-accent-foreground' : ''}`} onClick={() => toggle('terminal')}><SquareTerminal class="size-3.5" />Terminal</button>
      <button class={`project-menu-item flex items-center gap-2 ${props.toolPanel === 'tree' ? 'bg-accent text-accent-foreground' : ''} ${!props.sessionId ? 'project-menu-item-disabled' : ''}`} disabled={!props.sessionId} onClick={() => props.sessionId && toggle('tree')}><GitFork class="size-3.5" />Tree</button>
      <button class={`project-menu-item flex items-center gap-2 ${props.toolPanel === 'review' ? 'bg-accent text-accent-foreground' : ''}`} onClick={() => toggle('review')}><GitCompareArrows class="size-3.5" />Review changes</button>
      <button class={`project-menu-item flex items-center gap-2 ${props.toolPanel === 'files' ? 'bg-accent text-accent-foreground' : ''}`} onClick={() => toggle('files')}><Files class="size-3.5" />Files</button>
    </div>
  );
}

function MobileMenu(props: {
  project?: Project;
  workspaceProject?: Project;
  projects: Project[];
  workspacesEnabled: boolean;
  workspacesConfigured: boolean;
  workspaces?: ProjectWorkspace[];
  workspacesLoading: boolean;
  workspacesError?: string;
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  selectedSessionTitle?: string;
  workspaceNotifications: Record<string, WorkspaceNotificationSummary>;
  sessionRunning: boolean;
  onProject: (id: string) => void;
  onWorkspace: (id: string) => void;
  onSession: (id: string, workspaceId?: string) => void;
  onNewSession: (workspaceId?: string) => void;
  onDeleteSession: (id: string) => void;
  onToggleWorkspaces: () => void;
  onCreateWorkspace: () => Promise<void> | void;
  onDeleteWorkspace: (workspace: ProjectWorkspace, options?: { force?: boolean }) => Promise<void> | void;
  onOpenNotifications: (workspaceId: string) => void;
  onClearNotifications: (workspaceId: string) => void;
  onClearProjectNotifications: () => void;
  onAddProject: () => void;
  onSettings: () => void;
  onRename: () => void;
  onDelete: () => void;
  onShare: () => void;
  onToolPanel: (panel?: ToolPanel) => void;
  onClose: () => void;
  onEdit: () => void;
  onCloseProject: () => void;
  notificationCount: number;
}) {
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = createSignal(false);
  const [sessionsDropdownOpen, setSessionsDropdownOpen] = createSignal(false);
  const [workspaceDropdownPos, setWorkspaceDropdownPos] = createSignal<{ top: number; left: number; width: number }>();
  const [sessionsDropdownPos, setSessionsDropdownPos] = createSignal<{ top: number; left: number; width: number }>();
  let workspaceDropdownTrigger: HTMLButtonElement | undefined;
  let sessionsDropdownTrigger: HTMLButtonElement | undefined;
  let workspaceDropdownContent: HTMLDivElement | undefined;
  let sessionsDropdownContent: HTMLDivElement | undefined;
  const [sessionToDelete, setSessionToDelete] = createSignal<{ workspaceId: string; session: SessionSummary }>();

  function openWorkspaceDropdown() {
    const next = !workspaceDropdownOpen();
    setWorkspaceDropdownOpen(next);
    if (next && workspaceDropdownTrigger) {
      const rect = workspaceDropdownTrigger.getBoundingClientRect();
      setWorkspaceDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }

  function openSessionsDropdown() {
    const next = !sessionsDropdownOpen();
    setSessionsDropdownOpen(next);
    if (next && sessionsDropdownTrigger) {
      const rect = sessionsDropdownTrigger.getBoundingClientRect();
      setSessionsDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }
  const [workspaceToDelete, setWorkspaceToDelete] = createSignal<ProjectWorkspace>();
  const [busyAction, setBusyAction] = createSignal<string>();
  const [deleteError, setDeleteError] = createSignal('');
  const headerProject = createMemo(() => props.workspaceProject ?? props.project);
  const sessions = createSessionsQuery(() => props.workspaceProject?.id, () => !props.workspacesEnabled || Boolean(props.selectedSessionId));
  const sessionItems = createMemo(() => sessions.data?.pages.flatMap((page) => page.sessions) ?? []);
  const selectedSessionTitle = createMemo(() => {
    const providedTitle = props.selectedSessionTitle?.trim();
    if (providedTitle) return providedTitle;
    const session = sessionItems().find((s) => s.id === props.selectedSessionId);
    return session?.title || (props.selectedSessionId ? 'Selected session' : 'Sessions');
  });

  createEffect(() => {
    if (!workspaceDropdownOpen()) return;
    const dismiss = (event: MouseEvent) => {
      if (workspaceDropdownTrigger?.contains(event.target as Node)) return;
      if (workspaceDropdownContent?.contains(event.target as Node)) return;
      setWorkspaceDropdownOpen(false);
    };
    window.addEventListener('mousedown', dismiss);
    onCleanup(() => window.removeEventListener('mousedown', dismiss));
  });

  createEffect(() => {
    if (!sessionsDropdownOpen()) return;
    const dismiss = (event: MouseEvent) => {
      if (sessionsDropdownTrigger?.contains(event.target as Node)) return;
      if (sessionsDropdownContent?.contains(event.target as Node)) return;
      setSessionsDropdownOpen(false);
    };
    window.addEventListener('mousedown', dismiss);
    onCleanup(() => window.removeEventListener('mousedown', dismiss));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (workspaceDropdownOpen()) { setWorkspaceDropdownOpen(false); return; }
        if (sessionsDropdownOpen()) { setSessionsDropdownOpen(false); return; }
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function newSession(workspaceId?: string) {
    const targetId = workspaceId ?? props.workspaceProject?.id;
    if (!targetId) return;
    props.onWorkspace(targetId);
    props.onNewSession(targetId);
    props.onClose();
  }

  async function deleteSession(workspaceId: string, session: SessionSummary) {
    setBusyAction(`session:${session.id}`);
    setDeleteError('');
    try {
      await api<{ ok: true }>(`/api/projects/${workspaceId}/session?sessionId=${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      setSessionToDelete(undefined);
      props.onDeleteSession(session.id);
      queryClient.removeQueries({ queryKey: ['session', workspaceId, session.id] });
      queryClient.removeQueries({ queryKey: ['session-tree', workspaceId, session.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete session');
    } finally {
      setBusyAction(undefined);
    }
  }

  async function createWorkspace() {
    setBusyAction('workspace:create');
    try {
      await props.onCreateWorkspace();
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteWorkspace(workspace: ProjectWorkspace, options?: { force?: boolean }) {
    setBusyAction(`workspace:${workspace.id}`);
    setDeleteError('');
    try {
      await props.onDeleteWorkspace(workspace, options);
      setWorkspaceToDelete(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete workspace');
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <>
      <div class="mobile-menu-backdrop" onMouseDown={props.onClose} />
      <div class="mobile-menu">
        <div class="mb-4 flex items-center gap-3">
          <Show when={headerProject()}>
            {(project) => (
              <span class="project-sidebar-avatar" style={projectColorStyle(project(), projectPreference(project()))}>
                <ProjectAvatarContent project={project()} preference={projectPreference(project())} />
              </span>
            )}
          </Show>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{headerProject()?.name ?? 'Workspace'}</div>
            <div class="truncate text-xs text-muted-foreground">{headerProject()?.path}</div>
          </div>
          <button class="project-modal-close" onClick={props.onClose}><X class="size-4" /></button>
        </div>
        <Show when={props.projects.length > 0}>
          <div class="mb-4">
            <button ref={workspaceDropdownTrigger} class="flex w-full items-center gap-2 rounded-xl bg-card px-3 py-2 text-left text-sm ring-1 ring-foreground/10 transition-colors hover:bg-accent hover:text-accent-foreground" onClick={openWorkspaceDropdown}>
              <span class="min-w-0 flex-1 truncate">Switch workspace</span>
              <ChevronDown class={`size-4 shrink-0 transition-transform ${workspaceDropdownOpen() ? 'rotate-180' : ''}`} />
            </button>
            <Show when={workspaceDropdownOpen()}>
              <Portal>
                <div ref={workspaceDropdownContent} class="fixed z-[80] max-h-[min(24rem,50vh)] overflow-y-auto rounded-xl bg-card p-1 shadow-2xl ring-1 ring-foreground/10" style={{ top: `${workspaceDropdownPos()?.top ?? 0}px`, left: `${workspaceDropdownPos()?.left ?? 0}px`, width: `min(20rem, calc(100vw - ${(workspaceDropdownPos()?.left ?? 0) + 8}px))`, 'min-width': `${workspaceDropdownPos()?.width ?? 0}px` }}>
                  <For each={props.projects.filter((p) => p.id !== props.project?.id)}>
                    {(project) => (
                      <button class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground" onClick={() => { setWorkspaceDropdownOpen(false); props.onProject(project.id); props.onClose(); }}>
                        <span class="project-tile h-7 w-7 text-xs" style={projectColorStyle(project, projectPreference(project))}>
                          <ProjectAvatarContent project={project} preference={projectPreference(project)} />
                        </span>
                        <span class="min-w-0 flex-1 truncate">{project.name}</span>
                      </button>
                    )}
                  </For>
                  <div class="project-menu-divider" />
                  <button class="project-menu-item flex items-center gap-2" onClick={() => { setWorkspaceDropdownOpen(false); props.onClose(); props.onAddProject(); }}><Plus class="size-3.5" />Open project</button>
                </div>
              </Portal>
            </Show>
          </div>
        </Show>
        <Show when={!props.projects.length}>
          <button class="button-secondary mb-4 w-full" onClick={() => { props.onClose(); props.onAddProject(); }}><Plus class="size-4" />Open project</button>
        </Show>
        <Show when={props.workspacesEnabled}>
          <div class="mb-4">
            <button class="button-secondary w-full" disabled={busyAction() === 'workspace:create'} onClick={createWorkspace}><Plus class="size-4" />{busyAction() === 'workspace:create' ? 'Creating...' : 'New workspace'}</button>
          </div>
        </Show>
        <Show when={props.workspacesError}>
          <div class="mb-4 rounded-2xl bg-destructive/10 p-3 text-sm text-destructive ring-1 ring-destructive/20">
            <div class="font-medium">Could not load workspaces</div>
            <div class="mt-1 text-xs leading-5">{props.workspacesError}</div>
            <button class="button-danger mt-3 h-8 px-2 text-xs" onClick={props.onToggleWorkspaces}>Disable workspaces</button>
          </div>
        </Show>
        <Show when={!props.workspacesEnabled}>
          <button class="button-secondary mb-4 w-full" onClick={() => newSession()}><SquarePen class="size-4" />New session</button>
        </Show>
        <div class="mb-3">
          <button ref={sessionsDropdownTrigger} class="flex w-full items-center gap-2 rounded-xl bg-card px-3 py-2 text-left text-sm ring-1 ring-foreground/10 transition-colors hover:bg-accent hover:text-accent-foreground" onClick={openSessionsDropdown}>
            <span class="min-w-0 flex-1 truncate">{selectedSessionTitle()}</span>
            <ChevronDown class={`size-4 shrink-0 transition-transform ${sessionsDropdownOpen() ? 'rotate-180' : ''}`} />
          </button>
          <Show when={sessionsDropdownOpen()}>
            <Portal>
              <div ref={sessionsDropdownContent} class="fixed z-[80] max-h-[min(24rem,50vh)] overflow-y-auto rounded-xl bg-card p-1 shadow-2xl ring-1 ring-foreground/10" style={{ top: `${sessionsDropdownPos()?.top ?? 0}px`, left: `${sessionsDropdownPos()?.left ?? 0}px`, width: `min(20rem, calc(100vw - ${(sessionsDropdownPos()?.left ?? 0) + 8}px))`, 'min-width': `${sessionsDropdownPos()?.width ?? 0}px` }}>
                <Show when={!props.workspacesEnabled}>
                  <SessionList
                    class="dropdown-session-list"
                    sessions={sessionItems()}
                    selectedSessionId={props.selectedSessionId}
                    loading={sessions.isLoading}
                    error={sessions.error}
                    hasMore={sessions.hasNextPage}
                    loadingMore={sessions.isFetchingNextPage}
                    onLoadMore={() => { void sessions.fetchNextPage(); }}
                    onSession={(session) => { setSessionsDropdownOpen(false); props.onSession(session.id); props.onClose(); }}
                    onDeleteSession={(session) => { setDeleteError(''); setSessionToDelete({ workspaceId: props.workspaceProject?.id ?? props.project?.id ?? '', session }); }}
                  />
                </Show>
                <Show when={props.workspacesEnabled}>
                  <div class="space-y-3">
                    <For each={props.workspaces ?? []}>
                      {(workspace) => (
                        <WorkspaceSessionGroup
                          workspace={workspace}
                          active={props.selectedWorkspaceId === workspace.id}
                          selectedSessionId={props.selectedSessionId}
                          notificationSummary={props.workspaceNotifications[workspace.id]}
                          onSelectWorkspace={() => { props.onWorkspace(workspace.id); props.onClose(); }}
                          onNewSession={() => newSession(workspace.id)}
                          onDeleteWorkspace={() => { setDeleteError(''); setWorkspaceToDelete(workspace); }}
                          onOpenNotifications={() => props.onOpenNotifications(workspace.id)}
                          onClearNotifications={() => props.onClearNotifications(workspace.id)}
                          onDeleteSession={(session) => { setDeleteError(''); setSessionToDelete({ workspaceId: workspace.id, session }); }}
                          onSession={(session) => { props.onSession(session.id, workspace.id); props.onClose(); }}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Portal>
          </Show>
        </div>
        <Show when={props.selectedSessionId}>
          <div class="mt-4 border-t border-border pt-3">
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Session</div>
            <div class="space-y-1">
              <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onRename(); }}><SquarePen class="size-3.5" />Rename</button>
              <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onShare(); }}><ExternalLink class="size-3.5" />Share</button>
              <button class={`project-menu-item flex items-center gap-2 ${props.sessionRunning ? 'project-menu-item-disabled' : 'project-menu-item-danger'}`} disabled={props.sessionRunning} onClick={() => { props.onClose(); props.onDelete(); }}><Trash2 class="size-3.5" />Delete</button>
            </div>
          </div>
        </Show>
        <div class="mt-4 border-t border-border pt-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace</div>
          <div class="space-y-1">
            <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onEdit(); }}><SlidersHorizontal class="size-3.5" />Edit</button>
            <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onToggleWorkspaces(); }}><Database class="size-3.5" />{props.workspacesConfigured ? 'Disable workspaces' : 'Enable workspaces'}</button>
            <button class={`project-menu-item flex items-center gap-2 ${props.notificationCount ? '' : 'project-menu-item-disabled'}`} disabled={!props.notificationCount} onClick={() => { props.onClose(); props.onClearProjectNotifications(); }}><Bell class="size-3.5" />Clear notifications{props.notificationCount ? ` (${props.notificationCount})` : ''}</button>
            <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onCloseProject(); }}><Archive class="size-3.5" />Close</button>
          </div>
        </div>
        <div class="mt-4 border-t border-border pt-3">
          <button class="project-menu-item flex items-center gap-2" onClick={() => { props.onClose(); props.onSettings(); }}><Settings class="size-3.5" />Settings</button>
        </div>
      </div>
      <Show when={sessionToDelete()}>
        {(target) => (
          <ConfirmDialog
            title="Delete session?"
            description={`This will permanently delete "${target().session.title || 'New session'}" and its transcript. This cannot be undone.`}
            confirmLabel="Delete"
            busyLabel="Deleting..."
            variant="danger"
            busy={busyAction() === `session:${target().session.id}`}
            error={deleteError()}
            onCancel={() => setSessionToDelete(undefined)}
            onConfirm={() => void deleteSession(target().workspaceId, target().session)}
          />
        )}
      </Show>
      <Show when={workspaceToDelete()}>
        {(target) => (
          <WorkspaceDeleteDialog
            workspace={target()}
            busy={busyAction() === `workspace:${target().id}`}
            error={deleteError()}
            onCancel={() => setWorkspaceToDelete(undefined)}
            onConfirm={(force) => void deleteWorkspace(target(), { force })}
          />
        )}
      </Show>
    </>
  );
}

function WorkspaceMain(props: { project?: Project; sessionId?: string; events: string[]; toolPanel?: ToolPanel; themeMode: ResolvedThemeMode; contrastUserMessages: boolean; searchQuery: string; searchRequest: ChatSearchRequest; fileSearchRequest: number; onSearchState: (state: ChatSearchState) => void; onSession: (id: string, projectId?: string, expectedSessionId?: string | null) => void; onClosePanel: () => void }) {
  let terminalSplitRef: HTMLDivElement | undefined;
  let workspaceSplitRef: HTMLDivElement | undefined;
  let terminalFileInvalidationTimer: number | undefined;
  let terminalServerFileInvalidationTimer: number | undefined;
  const reviewWorkspaceStates = new Map<string, ReviewWorkspaceState>();
  function reviewWorkspaceState(projectId: string) {
    let state = reviewWorkspaceStates.get(projectId);
    if (!state) {
      state = createReviewWorkspaceState();
      reviewWorkspaceStates.set(projectId, state);
    }
    return state;
  }
  const terminalFileInvalidationProjectIds = new Set<string>();
  const terminalServerFileInvalidationProjectIds = new Set<string>();
  const [treeSelection, setTreeSelection] = createSignal<TreeSelection>();
  const terminal = createResizableDimension({
    defaultSize: TERMINAL_DEFAULT_HEIGHT,
    minSize: TERMINAL_MIN_HEIGHT,
    maxSize: () => Math.max(TERMINAL_MIN_HEIGHT, (terminalSplitRef?.getBoundingClientRect().height ?? window.innerHeight) - TERMINAL_CHAT_MIN_HEIGHT),
    keyStep: TERMINAL_RESIZE_KEY_STEP,
    axis: 'y',
    dragMultiplier: -1,
    increaseKey: 'ArrowUp',
    decreaseKey: 'ArrowDown',
    cursor: 'ns-resize',
  });
  const treePanel = createResizableDimension({
    defaultSize: TREE_PANEL_DEFAULT_WIDTH,
    minSize: TREE_PANEL_MIN_WIDTH,
    maxSize: () => Math.max(TREE_PANEL_MIN_WIDTH, (workspaceSplitRef?.getBoundingClientRect().width ?? window.innerWidth) - TREE_PANEL_CHAT_MIN_WIDTH),
    keyStep: TREE_PANEL_RESIZE_KEY_STEP,
    axis: 'x',
    dragMultiplier: -1,
    increaseKey: 'ArrowLeft',
    decreaseKey: 'ArrowRight',
    cursor: 'ew-resize',
  });
  const fileExplorer = createResizableDimension({
    defaultSize: FILE_EXPLORER_DEFAULT_WIDTH,
    minSize: FILE_EXPLORER_MIN_WIDTH,
    maxSize: () => Math.max(FILE_EXPLORER_MIN_WIDTH, (workspaceSplitRef?.getBoundingClientRect().width ?? window.innerWidth) - FILE_EXPLORER_CHAT_MIN_WIDTH),
    keyStep: FILE_EXPLORER_RESIZE_KEY_STEP,
    axis: 'x',
    dragMultiplier: -1,
    increaseKey: 'ArrowLeft',
    decreaseKey: 'ArrowRight',
    cursor: 'ew-resize',
  });

  function scheduleTerminalFileInvalidation(projectId: string) {
    terminalFileInvalidationProjectIds.add(projectId);
    terminalServerFileInvalidationProjectIds.add(projectId);
    if (terminalFileInvalidationTimer === undefined) {
      terminalFileInvalidationTimer = window.setTimeout(() => {
        const projectIds = [...terminalFileInvalidationProjectIds];
        terminalFileInvalidationProjectIds.clear();
        terminalFileInvalidationTimer = undefined;
        for (const id of projectIds) invalidateProjectFileQueries(id);
      }, TERMINAL_FILE_CLIENT_INVALIDATION_DEBOUNCE_MS);
    }
    if (terminalServerFileInvalidationTimer !== undefined) window.clearTimeout(terminalServerFileInvalidationTimer);
    terminalServerFileInvalidationTimer = window.setTimeout(() => {
      const projectIds = [...terminalServerFileInvalidationProjectIds];
      terminalServerFileInvalidationProjectIds.clear();
      terminalServerFileInvalidationTimer = undefined;
      for (const id of projectIds) invalidateProjectFileCaches(id);
    }, TERMINAL_FILE_SERVER_INVALIDATION_IDLE_MS);
  }

  onCleanup(() => {
    const pendingServerProjectIds = [...terminalServerFileInvalidationProjectIds];
    terminalFileInvalidationProjectIds.clear();
    terminalServerFileInvalidationProjectIds.clear();
    if (terminalFileInvalidationTimer !== undefined) window.clearTimeout(terminalFileInvalidationTimer);
    if (terminalServerFileInvalidationTimer !== undefined) window.clearTimeout(terminalServerFileInvalidationTimer);
    for (const id of pendingServerProjectIds) invalidateProjectFileCaches(id);
  });

  createEffect(() => {
    if (props.toolPanel !== 'terminal' || !terminalSplitRef) return;
    const clampHeight = () => terminal.setClampedSize(terminal.size());
    const observer = new ResizeObserver(clampHeight);
    observer.observe(terminalSplitRef);
    window.addEventListener('resize', clampHeight);
    queueMicrotask(clampHeight);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', clampHeight);
    });
  });

  createEffect(() => {
    if (props.toolPanel !== 'tree' || !workspaceSplitRef) return;
    const clampWidth = () => treePanel.setClampedSize(treePanel.size());
    const observer = new ResizeObserver(clampWidth);
    observer.observe(workspaceSplitRef);
    window.addEventListener('resize', clampWidth);
    queueMicrotask(clampWidth);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', clampWidth);
    });
  });

  createEffect(() => {
    if (props.toolPanel !== 'files' || !workspaceSplitRef) return;
    const clampWidth = () => fileExplorer.setClampedSize(fileExplorer.size());
    const observer = new ResizeObserver(clampWidth);
    observer.observe(workspaceSplitRef);
    window.addEventListener('resize', clampWidth);
    queueMicrotask(clampWidth);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', clampWidth);
    });
  });

  createEffect(() => {
    props.sessionId;
    setTreeSelection(undefined);
  });

  return (
    <div class="h-full min-h-0 overflow-hidden">
      <Show when={props.project} fallback={<div class="grid h-full place-items-center text-sm text-muted-foreground">Open a project to start.</div>}>
        {(project) => (
          <Show
            when={props.toolPanel === 'review'}
            fallback={
              <Show
                when={props.toolPanel === 'terminal'}
                fallback={
                  <div
                    ref={workspaceSplitRef}
                    class={props.toolPanel === 'tree' || props.toolPanel === 'files' ? 'grid h-full min-h-0 overflow-hidden' : 'h-full min-h-0 overflow-hidden'}
                    style={props.toolPanel === 'tree' ? { 'grid-template-columns': `minmax(0, 1fr) ${treePanel.size()}px` } : props.toolPanel === 'files' ? { 'grid-template-columns': `minmax(0, 1fr) ${fileExplorer.size()}px` } : {}}
                  >
                    <Chat project={project()} sessionId={props.sessionId} events={props.events} treeSelection={treeSelection()} themeMode={props.themeMode} contrastUserMessages={props.contrastUserMessages} searchQuery={props.searchQuery} searchRequest={props.searchRequest} onSearchState={props.onSearchState} onSession={props.onSession} onTreeSelection={setTreeSelection} />
                    <Show when={props.toolPanel === 'tree' && props.sessionId}><SessionTreePanel project={project()} sessionId={props.sessionId!} selectedId={treeSelection()?.entry.id} resizing={treePanel.resizing()} onSelect={setTreeSelection} onResizeStart={treePanel.startResize} onResizeKeyDown={treePanel.resizeWithKeyboard} onResizeReset={() => treePanel.setClampedSize(TREE_PANEL_DEFAULT_WIDTH)} onClose={props.onClosePanel} /></Show>
                    <Show when={props.toolPanel === 'files'}><FileExplorer project={project()} themeMode={props.themeMode} searchRequest={props.fileSearchRequest} resizing={fileExplorer.resizing()} onResizeStart={fileExplorer.startResize} onResizeKeyDown={fileExplorer.resizeWithKeyboard} onResizeReset={() => fileExplorer.setClampedSize(FILE_EXPLORER_DEFAULT_WIDTH)} onClose={props.onClosePanel} /></Show>
                  </div>
                }
              >
                <div ref={terminalSplitRef} class="terminal-split mobile-terminal" style={{ 'grid-template-rows': `minmax(0, 1fr) auto ${terminal.size()}px` }}>
                  <Chat project={project()} sessionId={props.sessionId} events={props.events} treeSelection={treeSelection()} themeMode={props.themeMode} contrastUserMessages={props.contrastUserMessages} searchQuery={props.searchQuery} searchRequest={props.searchRequest} onSearchState={props.onSearchState} onSession={props.onSession} onTreeSelection={setTreeSelection} />
                  <div
                    class="terminal-resize-handle"
                    role="separator"
                    aria-label="Resize terminal"
                    aria-orientation="horizontal"
                    aria-valuemin={TERMINAL_MIN_HEIGHT}
                    aria-valuemax={terminal.maxSize()}
                    aria-valuenow={terminal.size()}
                    tabIndex={0}
                    data-dragging={terminal.resizing() ? 'true' : 'false'}
                    onDblClick={() => terminal.setClampedSize(TERMINAL_DEFAULT_HEIGHT)}
                    onKeyDown={terminal.resizeWithKeyboard}
                    onPointerDown={terminal.startResize}
                  />
                  <Suspense fallback={<section class="terminal-panel"><div class="terminal-toolbar"><div class="terminal-title"><SquareTerminal class="size-3.5" /><span>Loading terminal...</span></div><button class="ghost" type="button" title="Close terminal" aria-label="Close terminal" onClick={props.onClosePanel}><X class="size-4" /></button></div><div class="terminal-host" /></section>}>
                    <TerminalPanel project={project()} themeMode={props.themeMode} onFilesystemActivity={() => scheduleTerminalFileInvalidation(project().id)} onClose={props.onClosePanel} />
                  </Suspense>
                </div>
              </Show>
            }
          >
            <Show when={project()} keyed>
              {(reviewProject) => <ReviewWorkspace project={reviewProject} state={reviewWorkspaceState(reviewProject.id)} themeMode={props.themeMode} onClose={props.onClosePanel} />}
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}

function Chat(props: { project: Project; sessionId?: string; events: string[]; treeSelection?: TreeSelection; themeMode: ResolvedThemeMode; contrastUserMessages: boolean; searchQuery: string; searchRequest: ChatSearchRequest; onSearchState: (state: ChatSearchState) => void; onSession: (id: string, projectId?: string, expectedSessionId?: string | null) => void; onTreeSelection: (selection?: TreeSelection) => void }) {
  let transcriptScrollerRef: HTMLDivElement | undefined;
  let composerRef: HTMLTextAreaElement | undefined;
  let composerHighlightsRef: HTMLDivElement | undefined;
  const commandSessionPromises = new Map<string, Promise<string | undefined>>();
  const clearedComposerDraftKeys = new Set<string>();
  let previousSearchKey = '';
  let handledSearchRequestSeq = props.searchRequest.seq;
  let activeComposerDraftKey: string | undefined;
  let activeComposerDraftTreeSelection: TreeSelection | undefined;
  let restoringComposerDraftTreeSelection: TreeSelection | undefined;
  let runningCommandToken: symbol | undefined;
  const transcriptEntryRefs = new Map<string, HTMLDivElement>();
  let userScrollingTranscriptAwayFromBottom = false;
  let composerHistoryIndex: number | undefined;
  let composerHistoryMode: ComposerHistoryMode | undefined;
  let composerHistoryDraft: ComposerHistoryItem = { text: '', uploads: [] };
  const [text, setText] = createSignal('');
  const [stickToBottom, setStickToBottom] = createSignal(true);
  const [uploads, setUploads] = createSignal<UploadAsset[]>([]);
  const [previewPath, setPreviewPath] = createSignal<string>();
  const [model, setModel] = createSignal('');
  const [thinkingLevel, setThinkingLevel] = createSignal<ThinkingLevel | ''>('');
  const [fileMention, setFileMention] = createSignal<FileMention>();
  const [fileMentionSearchQuery, setFileMentionSearchQuery] = createSignal<string>();
  const [slashCommandMention, setSlashCommandMention] = createSignal<SlashCommandMention>();
  const [commandArgumentMention, setCommandArgumentMention] = createSignal<CommandArgumentMention>();
  const [highlightedFileIndex, setHighlightedFileIndex] = createSignal(0);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = createSignal(0);
  const [highlightedCompletionIndex, setHighlightedCompletionIndex] = createSignal(0);
  const [runningCommand, setRunningCommand] = createSignal<string>();
  const [commandSessionId, setCommandSessionId] = createSignal<string>();
  const [pendingUserMessage, setPendingUserMessage] = createSignal<{ sessionId: string; text: string; attachments: UploadAsset[]; userMessageCount: number }>();
  const [composerHistory, setComposerHistory] = createSignal<ComposerHistoryItem[]>(readComposerHistory(props.project.id, 'normal'));
  const [composerShellHistory, setComposerShellHistory] = createSignal<ComposerHistoryItem[]>(readComposerHistory(props.project.id, 'shell'));
  const [aborting, setAborting] = createSignal(false);
  const [sessionControlsHydratedKey, setSessionControlsHydratedKey] = createSignal<string>();
  const autocompleteSessionId = createMemo(() => props.sessionId ?? commandSessionId());
  const session = createQuery(() => ({
    queryKey: ['session', props.project.id, props.sessionId],
    queryFn: ({ signal }) => api<SessionDetail>(`/api/projects/${props.project.id}/session?sessionId=${encodeURIComponent(props.sessionId!)}`, { signal }),
    enabled: Boolean(props.sessionId),
    staleTime: SESSION_DETAIL_CACHE_STALE_TIME_MS,
  }));
  const fileMentionSearchPending = createMemo(() => Boolean(fileMention() && fileMentionSearchQuery() !== fileMention()?.query));
  const fileSearch = createQuery(() => {
    const query = fileMentionSearchQuery() ?? '';
    return {
      queryKey: ['file-search', props.project.id, query],
      queryFn: ({ signal }) => api<{ files: ProjectFileSearchEntry[] }>(`/api/projects/${props.project.id}/files/search?query=${encodeURIComponent(query)}`, { signal }),
      enabled: Boolean(fileMention() && fileMentionSearchQuery() !== undefined && !fileMentionSearchPending()),
      staleTime: 0,
    };
  });
  const fileMentionFiles = createMemo(() => fileMentionSearchPending() ? [] : fileSearch.data?.files ?? []);
  const slashCommands = createQuery(() => ({
    queryKey: ['commands', props.project.id, autocompleteSessionId()],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      const sessionId = autocompleteSessionId();
      if (sessionId) params.set('sessionId', sessionId);
      return api<{ commands: SlashCommand[] }>(`/api/projects/${props.project.id}/agent/commands${params.size ? `?${params}` : ''}`, { signal });
    },
    enabled: Boolean(slashCommandMention() || commandArgumentMention()),
    staleTime: 60_000,
  }));
  const commandForArgument = createMemo(() => {
    const mention = commandArgumentMention();
    return mention ? slashCommands.data?.commands.find((command) => command.name === mention.commandName) : undefined;
  });
  const commandCompletions = createQuery(() => ({
    queryKey: ['command-completions', props.project.id, autocompleteSessionId(), commandArgumentMention()?.commandName ?? '', commandArgumentMention()?.query ?? ''],
    queryFn: ({ signal }) => {
      const mention = commandArgumentMention()!;
      const params = new URLSearchParams({ command: mention.commandName, prefix: mention.query });
      const sessionId = autocompleteSessionId();
      if (sessionId) params.set('sessionId', sessionId);
      return api<{ completions: CommandCompletion[] }>(`/api/projects/${props.project.id}/agent/command-completions?${params}`, { signal });
    },
    enabled: Boolean(commandArgumentMention() && commandForArgument()?.hasArgumentCompletions),
    staleTime: 60_000,
  }));
  const settings = createQuery(() => ({
    queryKey: ['settings', props.project.id],
    queryFn: ({ signal }) => api<PiSettingsResponse>(`/api/projects/${props.project.id}/settings`, { signal }),
    staleTime: SETTINGS_CACHE_STALE_TIME_MS,
  }));
  const models = createQuery(() => ({
    queryKey: ['models', props.project.id],
    queryFn: ({ signal }) => api<{ models: ModelListItem[] }>(`/api/projects/${props.project.id}/agent/models`, { signal }),
    staleTime: 5 * 60_000,
  }));
  const effectiveSettings = createMemo(() => settings.data?.effective);
  const hideThinking = createMemo(() => Boolean(effectiveSettings()?.hideThinkingBlock));
  const toolOutputMode = createMemo(() => chatToolOutputMode(effectiveSettings()));
  const syntaxTheme = createMemo(() => shikiSyntaxTheme(props.themeMode, effectiveSettings()));
  const modelOptions = createMemo(() => composerModelOptions(effectiveSettings(), models.data?.models ?? [], model()));
  const thinkingLevelOptions = createMemo(() => composerThinkingLevelOptions(effectiveSettings(), models.data?.models ?? [], model()));
  const transcriptEntries = createMemo(() => {
    const detail = session.data;
    if (!detail) return [];
    if (props.treeSelection) return branchForEntry(detail.entries, props.treeSelection.branchFromId);
    return detail.branch;
  });
  const pendingUserMessageVisible = createMemo(() => {
    const pending = pendingUserMessage();
    if (!pending) return false;
    if (props.sessionId && pending.sessionId !== props.sessionId) return false;
    return userMessageCount(transcriptEntries()) <= pending.userMessageCount;
  });
  const visibleTranscriptEntries = createMemo(() => {
    const options = { hideThinking: hideThinking(), toolOutputMode: toolOutputMode() };
    const entries = transcriptEntries().filter((entry) => shouldDisplayTranscriptEntry(entry, options));
    if (pendingUserMessageVisible() && !entries.some(isUserMessageEntry)) return [];
    return chatDisplayEntries(entries);
  });
  const toolCalls = createMemo(() => toolCallMap(transcriptEntries()));
  const chatSearchMatches = createMemo(() => {
    const query = normalizedSearchQuery(props.searchQuery);
    if (!query) return [];
    const options = { hideThinking: hideThinking(), toolOutputMode: toolOutputMode() };
    return visibleTranscriptEntries().filter((entry) => transcriptEntrySearchText(entry, options, toolCalls()).toLowerCase().includes(query));
  });
  const chatSearchMatchIds = createMemo(() => new Set(chatSearchMatches().map((entry) => entry.id)));
  const [activeSearchIndex, setActiveSearchIndex] = createSignal(0);
  const activeSearchEntryId = createMemo(() => chatSearchMatches()[activeSearchIndex()]?.id);
  const filteredSlashCommands = createMemo(() => filterSlashCommands(slashCommands.data?.commands ?? [], slashCommandMention()?.query ?? ''));
  const commandCompletionOptions = createMemo(() => commandCompletions.data?.completions ?? []);
  const liveActivity = createMemo(() => agentActivity(props.events));
  const liveShellActivity = createMemo(() => bashActivity(props.events));
  const busy = createMemo(() => liveActivity().running || Boolean(runningCommand()));
  const showEmptySessionPrompt = createMemo(() => Boolean(props.sessionId && !session.isLoading && !session.error && visibleTranscriptEntries().length === 0 && !busy() && !pendingUserMessageVisible()));
  const centerTranscript = createMemo(() => (!props.sessionId && !pendingUserMessageVisible()) || showEmptySessionPrompt());
  const agentStatus = createQuery(() => {
    const sessionId = props.sessionId;
    return {
      queryKey: ['agent-status', props.project.id, sessionId ?? 'active'],
      queryFn: ({ signal }) => api<{ status: AgentStatusInfo }>(`/api/projects/${props.project.id}/agent/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, { signal }),
      refetchInterval: busy() ? 1500 : 5000,
    };
  });

  createEffect(() => {
    props.sessionId;
    session.data?.leafId;
    transcriptEntries().map((entry) => entry.id).join('|');
    props.events.length;
    props.events[props.events.length - 1];
    uploads().length;
    runningCommand();
    if (stickToBottom()) scrollTranscriptToBottom();
  });

  createEffect(() => {
    const pending = pendingUserMessage();
    if (!pending) return;
    if (props.sessionId && pending.sessionId !== props.sessionId) {
      setPendingUserMessage(undefined);
      return;
    }
    if (userMessageCount(transcriptEntries()) > pending.userMessageCount) setPendingUserMessage(undefined);
  });

  createEffect(() => {
    const key = `${normalizedSearchQuery(props.searchQuery)}\n${chatSearchMatches().map((entry) => entry.id).join('\n')}`;
    if (key === previousSearchKey) return;
    previousSearchKey = key;
    setActiveSearchIndex(0);
  });

  createEffect(() => {
    const request = props.searchRequest;
    if (request.seq === handledSearchRequestSeq) return;
    handledSearchRequestSeq = request.seq;
    const total = chatSearchMatches().length;
    if (!normalizedSearchQuery(props.searchQuery) || !total) return;
    setActiveSearchIndex((index) => (index + request.direction + total) % total);
  });

  createEffect(() => {
    const query = normalizedSearchQuery(props.searchQuery);
    const total = query ? chatSearchMatches().length : 0;
    const activeIndex = total ? Math.min(activeSearchIndex() + 1, total) : 0;
    props.onSearchState({ activeIndex, total });
  });

  createEffect(() => {
    const activeId = activeSearchEntryId();
    if (!activeId || !normalizedSearchQuery(props.searchQuery)) return;
    const index = visibleTranscriptEntries().findIndex((entry) => entry.id === activeId);
    if (index === -1) return;
    requestAnimationFrame(() => transcriptEntryRefs.get(activeId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  });

  createEffect(() => {
    const nextComposerDraftKey = composerDraftKey(props.project.id, props.sessionId);
    const nextTreeSelection = props.treeSelection;
    if (activeComposerDraftKey === nextComposerDraftKey) {
      activeComposerDraftTreeSelection = nextTreeSelection;
      return;
    }
    if (activeComposerDraftKey) saveActiveComposerDraft(activeComposerDraftKey);
    activeComposerDraftKey = nextComposerDraftKey;

    const draft = readComposerDraft(nextComposerDraftKey);
    activeComposerDraftTreeSelection = draft.treeSelection ?? nextTreeSelection;
    if (draft.treeSelection) {
      const treeSelection = draft.treeSelection;
      restoringComposerDraftTreeSelection = treeSelection;
      if (treeSelection !== nextTreeSelection) {
        queueMicrotask(() => {
          if (activeComposerDraftKey !== nextComposerDraftKey) return;
          restoringComposerDraftTreeSelection = treeSelection;
          props.onTreeSelection(treeSelection);
        });
      }
    }
    setText(draft.text);
    setUploads(draft.uploads);
    setFileMention(undefined);
    setSlashCommandMention(undefined);
    setCommandArgumentMention(undefined);
    setHighlightedFileIndex(0);
    setHighlightedCommandIndex(0);
    setHighlightedCompletionIndex(0);
    resetComposerHistory();
    setComposerHistory(readComposerHistory(props.project.id, 'normal'));
    setComposerShellHistory(readComposerHistory(props.project.id, 'shell'));
    setPendingUserMessage((pending) => pending && props.sessionId && pending.sessionId === props.sessionId ? pending : undefined);
    const controlsSessionId = props.sessionId ?? draft.commandSessionId;
    const storedControls = controlsSessionId ? readSessionComposerControls(props.project.id, controlsSessionId) : undefined;
    setModel(storedControls && 'model' in storedControls ? storedControls.model ?? '' : draft.model ?? '');
    setThinkingLevel(storedControls && 'thinking' in storedControls ? storedControls.thinking ?? '' : draft.thinking ?? '');
    setSessionControlsHydratedKey(undefined);
    setCommandSessionId(props.sessionId ? undefined : draft.commandSessionId);
    runningCommandToken = undefined;
    setRunningCommand(undefined);
    setStickToBottom(true);
    scrollTranscriptToBottom(true);
  });

  createEffect(() => {
    fileMention()?.query;
    setHighlightedFileIndex(0);
  });

  createEffect(() => {
    const mention = fileMention();
    if (!mention) {
      setFileMentionSearchQuery(undefined);
      return;
    }
    const timeout = window.setTimeout(() => setFileMentionSearchQuery(mention.query), FILE_SEARCH_DEBOUNCE_MS);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    slashCommandMention()?.query;
    setHighlightedCommandIndex(0);
  });

  createEffect(() => {
    commandArgumentMention()?.query;
    setHighlightedCompletionIndex(0);
  });

  createEffect(() => {
    const detail = session.data;
    if (!props.sessionId || !detail) return;
    const key = `${props.project.id}:${props.sessionId}:${detail.leafId ?? ''}:${detail.branch.length}`;
    if (sessionControlsHydratedKey() === key) return;
    const stored = readSessionComposerControls(props.project.id, props.sessionId);
    setModel(stored && 'model' in stored ? stored.model ?? '' : sessionModelReference(detail) ?? '');
    setThinkingLevel(stored && 'thinking' in stored ? stored.thinking ?? '' : sessionThinkingLevel(detail) ?? '');
    setSessionControlsHydratedKey(key);
  });

  createEffect(() => {
    const selectedModel = model();
    if (selectedModel && !modelOptions().some((option) => option.value === selectedModel)) setModel('');
  });

  createEffect(() => {
    const selectedThinkingLevel = thinkingLevel();
    if (selectedThinkingLevel && !thinkingLevelOptions().some((option) => option.value === selectedThinkingLevel)) setThinkingLevel('');
  });

  createEffect(() => {
    text();
    syncComposerLayout();
  });

  onCleanup(() => {
    if (!activeComposerDraftKey) return;
    const draftKey = activeComposerDraftKey;
    activeComposerDraftKey = undefined;
    saveActiveComposerDraft(draftKey);
  });

  onMount(() => {
    let lastEscapeAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !busy()) return;
      const now = Date.now();
      const isDoubleEscape = now - lastEscapeAt < 500;
      lastEscapeAt = now;
      if (document.activeElement === composerRef || isDoubleEscape) {
        event.preventDefault();
        void interruptAgent();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncComposerLayout);
    if (observer && composerRef) observer.observe(composerRef);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      observer?.disconnect();
    });
  });

  function saveActiveComposerDraft(key: string) {
    const draft = {
      text: untrack(text),
      uploads: cloneUploadAssets(untrack(uploads)),
      commandSessionId: untrack(commandSessionId),
      treeSelection: activeComposerDraftTreeSelection,
      model: untrack(model),
      thinking: untrack(thinkingLevel),
    };
    if (clearedComposerDraftKeys.has(key)) {
      clearedComposerDraftKeys.delete(key);
      if (!draft.text && !draft.uploads.length) {
        saveComposerDraft(key, { text: '', uploads: [] });
        return;
      }
    }
    saveComposerDraft(key, draft);
  }

  function transcriptDistanceFromBottom(element: HTMLElement) {
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  }

  function updateTranscriptStickiness(element: HTMLElement) {
    const distance = transcriptDistanceFromBottom(element);
    if (distance < 4) userScrollingTranscriptAwayFromBottom = false;
    setStickToBottom(!userScrollingTranscriptAwayFromBottom && distance < 120);
  }

  function handleTranscriptWheel(event: WheelEvent & { currentTarget: HTMLDivElement }) {
    if (event.deltaY < 0) {
      userScrollingTranscriptAwayFromBottom = true;
      setStickToBottom(false);
      return;
    }
    updateTranscriptStickiness(event.currentTarget);
  }

  function scrollTranscriptToBottom(force = false) {
    if (force) userScrollingTranscriptAwayFromBottom = false;
    requestAnimationFrame(() => {
      const element = transcriptScrollerRef;
      if (!element || (!force && !stickToBottom())) return;
      element.scrollTop = element.scrollHeight;
      requestAnimationFrame(() => {
        if (!force && !stickToBottom()) return;
        element.scrollTop = element.scrollHeight;
      });
    });
  }

  async function ensureCommandSession(draftKey = activeComposerDraftKey ?? composerDraftKey(props.project.id, props.sessionId)) {
    const existing = autocompleteSessionId();
    if (existing) return existing;
    const pending = commandSessionPromises.get(draftKey);
    if (pending) return pending;
    const projectId = props.project.id;
    const promise = (async () => {
      const result = await api<{ session: SessionSummary }>(`/api/projects/${projectId}/sessions`, { method: 'POST' });
      if (activeComposerDraftKey === draftKey) setCommandSessionId(result.session.id);
      queryClient.invalidateQueries({ queryKey: ['sessions', projectId] });
      return result.session.id;
    })();
    commandSessionPromises.set(draftKey, promise);
    try {
      return await promise;
    } finally {
      if (commandSessionPromises.get(draftKey) === promise) commandSessionPromises.delete(draftKey);
    }
  }

  async function attach(files: Array<globalThis.File> | null) {
    if (!files?.length) return;
    const draftKey = activeComposerDraftKey;
    const draftSessionId = props.sessionId;
    const projectId = props.project.id;
    let sessionId = draftSessionId ?? commandSessionId();
    if (!sessionId) sessionId = await ensureCommandSession(draftKey);
    if (!sessionId) return;
    const form = new FormData();
    files.forEach((file) => form.append('file', file));
    const result = await api<{ uploaded: Array<{ filename: string; path: string; bytes: number }> }>(`/api/projects/${projectId}/uploads?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: form });
    if (activeComposerDraftKey === draftKey) {
      resetComposerHistory();
      setUploads((items) => composerUploadAssets([...items, ...result.uploaded]));
      return;
    }
    if (!draftKey) return;
    const draft = readComposerDraft(draftKey);
    saveComposerDraft(draftKey, {
      ...draft,
      uploads: uniqueUploadAssets([...draft.uploads, ...result.uploaded]),
      commandSessionId: draft.commandSessionId ?? (draftSessionId ? undefined : sessionId),
    });
  }

  createEffect(() => {
    const selection = props.treeSelection;
    if (!selection) {
      restoringComposerDraftTreeSelection = undefined;
      return;
    }
    if (selection === restoringComposerDraftTreeSelection) {
      restoringComposerDraftTreeSelection = undefined;
      return;
    }
    if (activeComposerDraftKey) clearedComposerDraftKeys.delete(activeComposerDraftKey);
    resetComposerHistory();
    setText(selection.text);
  });

  function updateFileMention(target: HTMLTextAreaElement) {
    updateComposerMentions(target.value, textareaActivePosition(target));
  }

  function updateComposerMentions(value: string, cursor: number) {
    const file = activeFileMention(value, cursor);
    const command = file ? undefined : activeSlashCommand(value, cursor);
    const commandArgument = file || command ? undefined : activeCommandArgument(value, cursor);
    setFileMention(file);
    setSlashCommandMention(command);
    setCommandArgumentMention(commandArgument);
  }

  function syncComposerLayout() {
    requestAnimationFrame(() => {
      const target = composerRef;
      if (!target) return;
      const style = window.getComputedStyle(target);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const lineHeightPx = Number.isFinite(lineHeight) ? lineHeight : 24;
      const minHeight = lineHeightPx * COMPOSER_MIN_LINES + verticalPadding;
      const maxHeight = lineHeightPx * COMPOSER_MAX_LINES + verticalPadding;
      const scrollTop = target.scrollTop;
      const scrollLeft = target.scrollLeft;
      target.style.height = 'auto';
      target.style.height = `${Math.min(Math.max(target.scrollHeight, minHeight), maxHeight)}px`;
      target.scrollTop = Math.min(scrollTop, Math.max(target.scrollHeight - target.clientHeight, 0));
      target.scrollLeft = scrollLeft;
      syncComposerHighlightsScroll(target);
    });
  }

  function syncComposerHighlightsScroll(target: HTMLTextAreaElement) {
    if (!composerHighlightsRef) return;
    composerHighlightsRef.scrollTop = target.scrollTop;
    composerHighlightsRef.scrollLeft = target.scrollLeft;
  }

  function replaceComposerRange(target: HTMLTextAreaElement, start: number, end: number, insert = '') {
    const cursor = start + insert.length;
    const nextText = `${target.value.slice(0, start)}${insert}${target.value.slice(end)}`;
    resetComposerHistory();
    setText(nextText);
    updateComposerMentions(nextText, cursor);
    requestAnimationFrame(() => {
      const element = composerRef ?? target;
      element.focus();
      element.setSelectionRange(cursor, cursor);
      syncComposerLayout();
    });
  }

  function resetComposerHistory() {
    composerHistoryIndex = undefined;
    composerHistoryMode = undefined;
    composerHistoryDraft = { text: '', uploads: [] };
  }

  function addComposerHistory(item: ComposerHistoryItem, mode: ComposerHistoryMode = 'normal', projectId = props.project.id) {
    const currentProject = projectId === props.project.id;
    const current = currentProject
      ? (mode === 'shell' ? composerShellHistory() : composerHistory())
      : readComposerHistory(projectId, mode);
    const next = prependComposerHistory(current, item);
    if (next === current) return;
    if (currentProject) {
      if (mode === 'shell') setComposerShellHistory(next);
      else setComposerHistory(next);
    }
    writeComposerHistory(projectId, mode, next);
  }

  function setComposerFromHistory(target: HTMLTextAreaElement, item: ComposerHistoryItem, cursor: 'start' | 'end') {
    setText(item.text);
    setUploads(cloneUploadAssets(item.uploads));
    setFileMention(undefined);
    setSlashCommandMention(undefined);
    setCommandArgumentMention(undefined);
    requestAnimationFrame(() => {
      const element = composerRef ?? target;
      const position = cursor === 'start' ? 0 : item.text.length;
      element.focus();
      element.setSelectionRange(position, position);
      syncComposerLayout();
    });
  }

  function handleComposerHistoryNavigation(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const target = event.currentTarget;
    if ((target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)) return false;
    const cursor = textareaActivePosition(target);
    const mode = composerHistoryIndex === undefined ? composerHistoryModeForDraft(target.value) : composerHistoryMode;
    if (!mode) return false;
    const history = mode === 'shell' ? composerShellHistory() : composerHistory();

    if (event.key === 'ArrowUp') {
      if (!history.length) return false;
      if (composerHistoryIndex === undefined && !canStartComposerHistoryNavigation(mode, target.value, cursor)) return false;
      if (composerHistoryIndex !== undefined && cursor !== 0 && cursor !== target.value.length) return false;
      if (composerHistoryIndex === history.length - 1) return false;
      event.preventDefault();
      if (composerHistoryIndex === undefined) {
        composerHistoryMode = mode;
        composerHistoryDraft = { text: target.value, uploads: composerUploadAssets(uploads()) };
      }
      composerHistoryIndex = (composerHistoryIndex ?? -1) + 1;
      setComposerFromHistory(target, history[composerHistoryIndex], 'start');
      return true;
    }

    if (composerHistoryIndex === undefined || (cursor !== 0 && cursor !== target.value.length)) return false;
    event.preventDefault();
    const nextIndex = composerHistoryIndex - 1;
    if (nextIndex < 0) {
      composerHistoryIndex = undefined;
      composerHistoryMode = undefined;
      setComposerFromHistory(target, composerHistoryDraft, 'end');
      composerHistoryDraft = { text: '', uploads: [] };
      return true;
    }
    composerHistoryIndex = nextIndex;
    setComposerFromHistory(target, history[composerHistoryIndex], 'end');
    return true;
  }

  function handleComposerNavigationShortcut(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.isComposing || event.metaKey) return false;
    const target = event.currentTarget;
    const key = event.key.toLowerCase();
    const value = target.value;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    const cursor = textareaActivePosition(target);

    if (event.ctrlKey && !event.altKey) {
      if (key === 'a') {
        event.preventDefault();
        setTextareaCursor(target, textareaLineStart(value, cursor), event.shiftKey);
        updateFileMention(target);
        return true;
      }
      if (key === 'e') {
        event.preventDefault();
        setTextareaCursor(target, textareaLineEnd(value, cursor), event.shiftKey);
        updateFileMention(target);
        return true;
      }
      if (key === 'b') {
        event.preventDefault();
        setTextareaCursor(target, Math.max(cursor - 1, 0), event.shiftKey);
        updateFileMention(target);
        return true;
      }
      if (key === 'f') {
        event.preventDefault();
        setTextareaCursor(target, Math.min(cursor + 1, value.length), event.shiftKey);
        updateFileMention(target);
        return true;
      }
      if (key === 'k') {
        event.preventDefault();
        if (start !== end) replaceComposerRange(target, start, end);
        else {
          const lineEnd = textareaLineEnd(value, cursor);
          replaceComposerRange(target, cursor, lineEnd === cursor ? Math.min(value.length, cursor + 1) : lineEnd);
        }
        return true;
      }
      if (key === 'u') {
        event.preventDefault();
        if (start !== end) replaceComposerRange(target, start, end);
        else replaceComposerRange(target, textareaLineStart(value, cursor), cursor);
        return true;
      }
      if (key === 'w') {
        event.preventDefault();
        if (start !== end) replaceComposerRange(target, start, end);
        else replaceComposerRange(target, textareaPreviousWordStart(value, cursor), cursor);
        return true;
      }
      if (key === 'd') {
        event.preventDefault();
        if (start !== end) replaceComposerRange(target, start, end);
        else if (cursor < value.length) replaceComposerRange(target, cursor, cursor + 1);
        return true;
      }
    }

    if (event.altKey && !event.ctrlKey) {
      if (key === 'b') {
        event.preventDefault();
        setTextareaCursor(target, textareaPreviousWordStart(value, cursor), event.shiftKey);
        updateFileMention(target);
        return true;
      }
      if (key === 'f') {
        event.preventDefault();
        setTextareaCursor(target, textareaNextWordEnd(value, cursor), event.shiftKey);
        updateFileMention(target);
        return true;
      }
    }

    return false;
  }

  function selectFileMention(file: ProjectFileSearchEntry) {
    const mention = fileMention();
    if (!mention) return;
    const suffix = text().slice(mention.end);
    const fileReference = formatComposerFileReference(file.path, mention.quoted);
    const insert = `${fileReference}${suffix.startsWith(' ') || suffix.startsWith('\n') ? '' : ' '}`;
    const nextText = `${text().slice(0, mention.start)}${insert}${suffix}`;
    const cursor = mention.start + insert.length;
    resetComposerHistory();
    setText(nextText);
    setFileMention(undefined);
    setSlashCommandMention(undefined);
    setCommandArgumentMention(undefined);
    requestAnimationFrame(() => {
      composerRef?.focus();
      composerRef?.setSelectionRange(cursor, cursor);
      syncComposerLayout();
    });
  }

  function selectSlashCommand(command: SlashCommand) {
    const mention = slashCommandMention();
    if (!mention) return;
    const suffix = text().slice(mention.end);
    const insert = `/${command.name}${suffix.startsWith(' ') || suffix.startsWith('\n') ? '' : ' '}`;
    const nextText = `${text().slice(0, mention.start)}${insert}${suffix}`;
    const cursor = mention.start + insert.length;
    resetComposerHistory();
    setText(nextText);
    setSlashCommandMention(undefined);
    setCommandArgumentMention(activeCommandArgument(nextText, cursor));
    requestAnimationFrame(() => {
      composerRef?.focus();
      composerRef?.setSelectionRange(cursor, cursor);
      syncComposerLayout();
    });
  }

  function selectCommandCompletion(completion: CommandCompletion) {
    const mention = commandArgumentMention();
    if (!mention) return;
    const suffix = text().slice(mention.end);
    const nextText = `${text().slice(0, mention.start)}${completion.value}${suffix}`;
    const cursor = mention.start + completion.value.length;
    resetComposerHistory();
    setText(nextText);
    setCommandArgumentMention(activeCommandArgument(nextText, cursor));
    requestAnimationFrame(() => {
      composerRef?.focus();
      composerRef?.setSelectionRange(cursor, cursor);
      syncComposerLayout();
    });
  }

  function removeUpload(path: string) {
    resetComposerHistory();
    setUploads((items) => items.filter((item) => item.path !== path));
  }

  async function interruptAgent() {
    const sessionId = props.sessionId ?? commandSessionId();
    if (aborting() || !sessionId) return;
    setAborting(true);
    try {
      await api(`/api/projects/${props.project.id}/agent/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      setRunningCommand(undefined);
    } finally {
      setAborting(false);
    }
  }

  async function compactSession(projectId: string, sessionId: string, instructions: string | undefined, mirrorActiveStream: boolean) {
    await api(`/api/projects/${projectId}/agent/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, instructions, mirrorActiveStream }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', projectId, sessionId] });
    await queryClient.invalidateQueries({ queryKey: ['session-tree', projectId, sessionId] });
    await queryClient.invalidateQueries({ queryKey: ['sessions', projectId] });
    await queryClient.invalidateQueries({ queryKey: ['agent-status', projectId, sessionId] });
  }

  async function executeShellCommand(projectId: string, sessionId: string, command: { command: string; excludeFromContext: boolean }, mirrorActiveStream: boolean, reflectActivity: () => boolean) {
    const token = Symbol('running-command');
    if (reflectActivity()) {
      runningCommandToken = token;
      setRunningCommand(command.command);
    }
    try {
      await api<BashCommandResult>(`/api/projects/${projectId}/agent/bash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, command: command.command, excludeFromContext: command.excludeFromContext, mirrorActiveStream }),
      });
      await queryClient.invalidateQueries({ queryKey: ['session', projectId, sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['session-tree', projectId, sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['sessions', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['agent-status', projectId, sessionId] });
    } finally {
      if (reflectActivity() && runningCommandToken === token) {
        runningCommandToken = undefined;
        setRunningCommand(undefined);
      }
    }
  }

  async function isExtensionComposerCommand(projectId: string, sessionId: string, prompt: string) {
    const commandName = composerSlashCommandName(prompt);
    if (!commandName) return false;
    const cached = slashCommands.data?.commands.find((command) => command.name === commandName);
    if (cached) return cached.source === 'extension';
    const result = await api<{ commands: SlashCommand[] }>(`/api/projects/${projectId}/agent/commands?sessionId=${encodeURIComponent(sessionId)}`);
    return result.commands.find((command) => command.name === commandName)?.source === 'extension';
  }

  function handleModelChange(value: string) {
    if (activeComposerDraftKey) clearedComposerDraftKeys.delete(activeComposerDraftKey);
    setModel(value);
    saveComposerControls({ model: value, thinking: thinkingLevel() });
  }

  function handleThinkingLevelChange(value: ThinkingLevel | '') {
    if (activeComposerDraftKey) clearedComposerDraftKeys.delete(activeComposerDraftKey);
    setThinkingLevel(value);
    saveComposerControls({ model: model(), thinking: value });
  }

  function saveComposerControls(controls: { model: string; thinking: ThinkingLevel | '' }) {
    const sessionId = props.sessionId ?? commandSessionId();
    if (sessionId) writeSessionComposerControls(props.project.id, sessionId, controls);
  }

  function promptThinkingOverride(selectedThinkingLevel: ThinkingLevel | '', sessionId: string, projectId: string, defaultThinkingLevel: ThinkingLevel | undefined): ThinkingLevel | undefined {
    if (selectedThinkingLevel) return selectedThinkingLevel;
    const stored = readSessionComposerControls(projectId, sessionId);
    return stored && 'thinking' in stored ? defaultThinkingLevel ?? 'medium' : undefined;
  }

  function handleComposerKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    const files = fileMentionFiles();
    if (fileMention()) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedFileIndex((index) => Math.min(index + 1, Math.max(files.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedFileIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const file = files[highlightedFileIndex()];
        if (file) selectFileMention(file);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setFileMention(undefined);
        return;
      }
    }

    if (slashCommandMention()) {
      const commands = filteredSlashCommands();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedCommandIndex((index) => Math.min(index + 1, Math.max(commands.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedCommandIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && commands.length) {
        event.preventDefault();
        const command = commands[highlightedCommandIndex()];
        if (command) selectSlashCommand(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashCommandMention(undefined);
        return;
      }
    }

    if (commandArgumentMention() && commandForArgument()?.hasArgumentCompletions) {
      const completions = commandCompletionOptions();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedCompletionIndex((index) => Math.min(index + 1, Math.max(completions.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedCompletionIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Tab' && completions.length) {
        event.preventDefault();
        const completion = completions[highlightedCompletionIndex()];
        if (completion) selectCommandCompletion(completion);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandArgumentMention(undefined);
        return;
      }
    }

    if (event.key === 'Escape' && busy()) {
      event.preventDefault();
      void interruptAgent();
      return;
    }

    if (handleComposerHistoryNavigation(event)) return;
    if (handleComposerNavigationShortcut(event)) return;

    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy() && text().trim()) event.currentTarget.form?.requestSubmit();
    }
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const prompt = text().trim();
    const uploadAssets = composerUploadAssets(uploads());
    if (!prompt || busy()) return;
    const projectId = props.project.id;
    const routeSessionId = props.sessionId;
    const submittedDraftKey = activeComposerDraftKey;
    const submittedTreeSelection = props.treeSelection ?? activeComposerDraftTreeSelection;
    const submittedModel = model();
    const submittedThinkingLevel = thinkingLevel();
    const submittedDefaultModel = defaultModelReference(effectiveSettings());
    const submittedDefaultThinkingLevel = effectiveSettings()?.defaultThinkingLevel;
    let submittedCommandSessionId = commandSessionId();
    const shellCommand = parseShellComposerCommand(prompt);
    const compactCommand = parseCompactComposerCommand(prompt);
    let sessionId = routeSessionId ?? commandSessionId();
    const mirrorActiveStream = !routeSessionId;
    if (compactCommand !== undefined && !sessionId) return;
    if (!sessionId) {
      try {
        sessionId = await ensureCommandSession(submittedDraftKey);
      } catch (error) {
        console.error('Could not create chat session', error);
        return;
      }
      if (!sessionId) return;
    }
    const submittedSessionId = sessionId;
    if (mirrorActiveStream) submittedCommandSessionId = submittedSessionId;
    if (submittedModel || submittedThinkingLevel) writeSessionComposerControls(projectId, submittedSessionId, { model: submittedModel, thinking: submittedThinkingLevel });
    const extensionCommand = !shellCommand && compactCommand === undefined
      ? await isExtensionComposerCommand(projectId, submittedSessionId, prompt).catch(() => false)
      : false;
    const submittedComposerStillActive = () => activeComposerDraftKey === submittedDraftKey;
    const submittedWorkspaceStillCurrent = () => props.project.id === projectId && (!props.sessionId || props.sessionId === submittedSessionId);
    const selectSubmittedSession = () => {
      if (mirrorActiveStream && submittedWorkspaceStillCurrent()) props.onSession(submittedSessionId, projectId, routeSessionId ?? null);
    };

    if (submittedComposerStillActive()) {
      setText('');
      setUploads([]);
      resetComposerHistory();
      setFileMention(undefined);
      setSlashCommandMention(undefined);
      setCommandArgumentMention(undefined);
      setStickToBottom(true);
      scrollTranscriptToBottom(true);
    }
    if (submittedDraftKey) {
      clearedComposerDraftKeys.add(submittedDraftKey);
      saveComposerDraft(submittedDraftKey, { text: '', uploads: [] });
    }

    try {
      if (shellCommand) {
        addComposerHistory({ text: prompt, uploads: [] }, 'shell', projectId);
        await executeShellCommand(projectId, submittedSessionId, shellCommand, mirrorActiveStream, submittedComposerStillActive);
        selectSubmittedSession();
        if (submittedComposerStillActive()) {
          props.onTreeSelection(undefined);
          scrollTranscriptToBottom(true);
        }
        return;
      }
      if (compactCommand !== undefined) {
        addComposerHistory({ text: prompt, uploads: [] }, 'normal', projectId);
        await compactSession(projectId, submittedSessionId, compactCommand, mirrorActiveStream);
        selectSubmittedSession();
        if (submittedComposerStillActive()) {
          props.onTreeSelection(undefined);
          scrollTranscriptToBottom(true);
        }
        return;
      }
      const attachmentAssets = uniqueUploadAssets([...uploadAssets, ...await resolveComposerFileReferenceAssets(projectId, prompt)]);
      const attachments = attachmentAssets.map((asset) => asset.path);
      addComposerHistory({ text: prompt, uploads: uploadAssets }, 'normal', projectId);
      if (!extensionCommand && submittedComposerStillActive()) setPendingUserMessage({ sessionId: submittedSessionId, text: prompt, attachments: attachmentAssets, userMessageCount: userMessageCount(transcriptEntries()) });
      await api(`/api/projects/${projectId}/agent/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: submittedSessionId,
          treeTargetId: submittedTreeSelection?.entry.id,
          treeSummary: submittedTreeSelection ? treeSummaryOptions(submittedTreeSelection) : undefined,
          prompt,
          attachments,
          mirrorActiveStream,
          model: submittedModel || submittedDefaultModel,
          thinking: promptThinkingOverride(submittedThinkingLevel, submittedSessionId, projectId, submittedDefaultThinkingLevel),
        }),
      });
      selectSubmittedSession();
      if (submittedComposerStillActive()) {
        props.onTreeSelection(undefined);
        scrollTranscriptToBottom(true);
      }
    } catch (error) {
      if (submittedDraftKey) clearedComposerDraftKeys.delete(submittedDraftKey);
      setPendingUserMessage((pending) => pending?.sessionId === submittedSessionId ? undefined : pending);
      if (activeComposerDraftKey === submittedDraftKey && !text().trim() && composerUploadAssets(uploads()).length === 0) {
        setText(prompt);
        setUploads(uploadAssets);
        syncComposerLayout();
      } else if (submittedDraftKey && !composerDrafts.has(submittedDraftKey)) {
        saveComposerDraft(submittedDraftKey, { text: prompt, uploads: uploadAssets, commandSessionId: submittedCommandSessionId, treeSelection: submittedTreeSelection, model: submittedModel, thinking: submittedThinkingLevel });
      }
      console.error('Could not send chat message', error);
    }
  }

  return (
    <div class={`grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden${props.contrastUserMessages ? '' : ' chat-user-bubbles-surface'}`}>
      <div
        ref={transcriptScrollerRef}
        class={`min-h-0 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-24 ${centerTranscript() ? 'grid place-items-center' : ''}`}
        onWheel={handleTranscriptWheel}
        onScroll={(event) => updateTranscriptStickiness(event.currentTarget)}
      >
        <div class="mx-auto w-full max-w-5xl">
          <div class="min-w-0">
            <Show when={!props.sessionId && !pendingUserMessageVisible()}>
              <div class="mx-auto w-full max-w-xl rounded-2xl bg-card p-5 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">Create or select a session, then ask Pi to work in this workspace.</div>
            </Show>
            <Show when={showEmptySessionPrompt()}>
              <div class="mx-auto w-full max-w-xl rounded-2xl bg-card p-5 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">Ask Pi to work in this workspace.</div>
            </Show>
            <Show when={props.sessionId && session.isLoading}>
              <div class="mb-4 rounded-2xl bg-card p-5 text-sm text-muted-foreground ring-1 ring-foreground/10">Loading session...</div>
            </Show>
            <Show when={props.sessionId && session.error}>
              <div class="mb-4 rounded-2xl bg-card p-5 text-sm text-destructive ring-1 ring-destructive/20">{session.error instanceof Error ? session.error.message : 'Could not load session'}</div>
            </Show>
            <For each={visibleTranscriptEntries()}>
              {(item, index) => {
                onCleanup(() => transcriptEntryRefs.delete(item.id));
                return (
                  <div
                    ref={(element) => transcriptEntryRefs.set(item.id, element)}
                    data-index={index()}
                    class={`chat-search-entry ${chatSearchMatchIds().has(item.id) ? 'chat-search-entry-match' : ''} ${activeSearchEntryId() === item.id ? 'chat-search-entry-active' : ''}`}
                  >
                    <TranscriptEntry entry={item} project={props.project} hideThinking={hideThinking()} toolOutputMode={toolOutputMode()} toolCalls={toolCalls()} syntaxTheme={syntaxTheme()} searchQuery={props.searchQuery} onPreviewAttachment={setPreviewPath} />
                  </div>
                );
              }}
            </For>
            <Show when={pendingUserMessageVisible() ? pendingUserMessage() : undefined}>
              {(pending) => <UserMessage project={props.project} parts={[{ type: 'text', text: pending().text }]} attachments={pending().attachments} syntaxTheme={syntaxTheme()} searchQuery={props.searchQuery} onPreviewAttachment={setPreviewPath} />}
            </Show>
            <LiveAgentActivity activity={liveActivity()} hideThinking={hideThinking()} toolOutputMode={toolOutputMode()} syntaxTheme={syntaxTheme()} />
            <LiveShellActivity activity={liveShellActivity()} command={runningCommand()} />
          </div>
        </div>
      </div>
      <form onSubmit={send} class="composer-form shrink-0 px-4 pb-4 xl:px-6">
        <div class="composer-shell relative mx-auto w-full max-w-5xl rounded-2xl border border-border bg-card shadow-floating">
          <Show when={fileMention()}>
            <div class="file-mention-menu">
              <Show when={!fileMentionSearchPending() && !fileSearch.isLoading} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">Searching files...</div>}>
                <Show when={fileMentionFiles().length > 0} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">No matching files</div>}>
                  <For each={fileMentionFiles()}>
                    {(file, index) => (
                      <button
                        type="button"
                        class={`file-mention-item ${highlightedFileIndex() === index() ? 'file-mention-item-active' : ''}`}
                        onMouseDown={(event) => { event.preventDefault(); selectFileMention(file); }}
                      >
                        <span class="grid w-7 shrink-0 place-items-center text-muted-foreground"><FileTypeIcon name={file.name} class="size-4" /></span>
                        <span class="min-w-0 flex-1 truncate text-left">{file.path}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </Show>
          <Show when={slashCommandMention()}>
            <div class="command-menu">
              <Show when={!slashCommands.isLoading} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">Loading commands...</div>}>
                <Show when={filteredSlashCommands().length > 0} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">No matching commands</div>}>
                  <For each={filteredSlashCommands()}>
                    {(command, index) => (
                      <button
                        type="button"
                        class={`command-item ${highlightedCommandIndex() === index() ? 'command-item-active' : ''}`}
                        onMouseDown={(event) => { event.preventDefault(); selectSlashCommand(command); }}
                      >
                        <span class="command-name">/{command.name}</span>
                        <Show when={command.description ?? command.argumentHint}><span class="command-description">{command.description ?? command.argumentHint}</span></Show>
                        <span class="command-source">{commandSourceLabel(command)}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </Show>
          <Show when={commandArgumentMention() && commandForArgument()?.hasArgumentCompletions}>
            <div class="command-menu">
              <Show when={!commandCompletions.isLoading} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">Loading options...</div>}>
                <Show when={commandCompletionOptions().length > 0} fallback={<div class="px-3 py-2 text-sm text-muted-foreground">No matching options</div>}>
                  <For each={commandCompletionOptions()}>
                    {(completion, index) => (
                      <button
                        type="button"
                        class={`command-item ${highlightedCompletionIndex() === index() ? 'command-item-active' : ''}`}
                        onMouseDown={(event) => { event.preventDefault(); selectCommandCompletion(completion); }}
                      >
                        <span class="command-name">{completion.label ?? completion.value}</span>
                        <span class="command-description">{completion.description}</span>
                        <span class="command-source">/{commandArgumentMention()?.commandName}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </Show>
          <Show when={uploads().length}>
            <div class="composer-attachments" aria-label="Attachments">
              <For each={uploads()}>
                {(asset) => (
                  <div class="composer-attachment-wrap">
                    <button type="button" class="composer-attachment" aria-label={`Preview ${uploadAssetLabel(asset)}`} onClick={() => setPreviewPath(asset.path)}>
                      <Show when={isImagePath(asset.path)} fallback={<span class="composer-attachment-icon"><FileTypeIcon name={asset.filename ?? asset.path} class="size-5" /></span>}>
                        <img class="composer-attachment-thumb" src={assetUrl(props.project.id, asset.path)} alt="" />
                      </Show>
                    </button>
                    <button type="button" class="composer-attachment-remove" aria-label={`Remove ${uploadAssetLabel(asset)}`} onClick={() => removeUpload(asset.path)}><X class="size-3" /></button>
                    <span class="composer-attachment-tooltip" role="tooltip">{uploadAssetLabel(asset)}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="composer-editor">
            <ComposerHighlights text={text()} setRef={(element) => { composerHighlightsRef = element; }} />
            <textarea
              ref={composerRef}
              class="composer-textarea"
              placeholder={props.treeSelection ? 'Prompt for selected tree node...' : 'Ask anything...'}
              value={text()}
              rows={1}
              onInput={(event) => { resetComposerHistory(); setText(event.currentTarget.value); updateFileMention(event.currentTarget); syncComposerLayout(); }}
              onClick={(event) => updateFileMention(event.currentTarget)}
              onScroll={(event) => {
                if (!composerHighlightsRef) return;
                syncComposerHighlightsScroll(event.currentTarget);
              }}
              onKeyUp={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateFileMention(event.currentTarget);
              }}
              onKeyDown={handleComposerKeyDown}
            />
          </div>
          <AgentStatusBar status={agentStatus.data?.status} loading={agentStatus.isLoading || agentStatus.isFetching} error={agentStatus.error} />
          <div class="composer-toolbar flex h-12 min-w-0 flex-nowrap items-center gap-1.5 border-t border-border px-3 text-sm max-xl:h-auto max-xl:py-2 max-md:gap-y-2">
            <label class="ghost h-8 w-8 cursor-pointer px-0" title="Add files"><Plus class="size-4" /><input class="hidden" type="file" multiple accept="image/*,video/*,.txt,.md,.pdf" onChange={(event) => { const files = event.currentTarget.files ? [...event.currentTarget.files] : null; event.currentTarget.value = ''; void attach(files).catch((error) => console.error('Could not attach files', error)); }} /></label>
            <UiSelect compact class="composer-model-select" contentWidth="content" triggerWidth="content" value={model()} onChange={handleModelChange} options={modelOptions()} ariaLabel="Model" />
            <UiSelect
              compact
              class="composer-thinking-select"
              contentWidth="content"
              triggerWidth="content"
              value={thinkingLevel()}
              onChange={(value) => handleThinkingLevelChange(value as ThinkingLevel | '')}
              options={thinkingLevelOptions()}
              ariaLabel="Thinking level"
            />
            <div class="composer-toolbar-spacer flex-1" />
            <Show when={busy()} fallback={<button class="button h-8 w-8 px-0" type="submit" title="Send"><ArrowUp class="size-4" /></button>}>
              <button class="button-danger h-8 w-8 px-0" type="button" title="Interrupt agent (Esc, or double Esc anywhere)" onClick={() => void interruptAgent()} disabled={aborting()}><Square class="size-3.5 fill-current" /></button>
            </Show>
          </div>
        </div>
      </form>
      <Show when={previewPath()}>
        {(path) => <AssetPreviewModal project={props.project} path={path()} themeMode={props.themeMode} onClose={() => setPreviewPath(undefined)} />}
      </Show>
    </div>
  );
}

function ComposerHighlights(props: { text: string; setRef?: (element: HTMLDivElement) => void }) {
  return (
    <div ref={props.setRef} class="composer-highlights" aria-hidden="true">
      <For each={composerHighlightParts(props.text)}>
        {(part) => <span class={part.kind === 'file' ? 'composer-highlight-file' : ''}>{part.text}</span>}
      </For>
    </div>
  );
}

function AgentStatusBar(props: { status?: AgentStatusInfo; loading?: boolean; error?: unknown }) {
  const parts = createMemo(() => {
    const statusParts = agentStatusParts(props.status);
    if (statusParts.length) return statusParts;
    if (props.loading) return [{ text: 'status loading...' }];
    if (props.error) return [{ text: 'status unavailable', title: errorMessage(props.error, 'Could not load status'), tone: 'warning' as const }];
    return [{ text: 'no status yet' }];
  });
  return (
    <div class="agent-status-bar max-md:max-h-none">
      <For each={parts()}>
        {(part) => <span class={`agent-status-item ${part.tone ? `agent-status-${part.tone}` : ''}`} title={part.title}>{part.text}</span>}
      </For>
    </div>
  );
}

function AssetPreviewModal(props: { project: Project; path: string; themeMode: ResolvedThemeMode; onClose: () => void }) {
  const [draftContent, setDraftContent] = createSignal('');
  const [savedContent, setSavedContent] = createSignal('');
  const [savedMtimeMs, setSavedMtimeMs] = createSignal<number>();
  const [savedEtag, setSavedEtag] = createSignal<string>();
  const [savedContentHash, setSavedContentHash] = createSignal<string>();
  const [loadedPath, setLoadedPath] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal('');
  const [confirmClose, setConfirmClose] = createSignal(false);
  const isText = createMemo(() => isTextPath(props.path));
  const dirty = createMemo(() => isText() && draftContent() !== savedContent());
  const settings = createQuery(() => ({
    queryKey: ['settings', props.project.id],
    queryFn: ({ signal }) => api<PiSettingsResponse>(`/api/projects/${props.project.id}/settings`, { signal }),
    staleTime: SETTINGS_CACHE_STALE_TIME_MS,
  }));
  const file = createQuery(() => ({
    queryKey: ['file-preview', props.project.id, props.path],
    queryFn: ({ signal }) => api<ProjectFilePreview>(`/api/projects/${props.project.id}/file?path=${encodeURIComponent(props.path)}`, { signal }),
    enabled: isText(),
    staleTime: 0,
    refetchOnWindowFocus: true,
  }));

  createEffect(() => {
    const preview = file.data;
    if (!preview || (loadedPath() === props.path && untrack(dirty))) return;
    setLoadedPath(props.path);
    setSavedContent(preview.content);
    setSavedMtimeMs(preview.mtimeMs);
    setSavedEtag(preview.etag);
    setSavedContentHash(preview.contentHash);
    setDraftContent(preview.content);
    setSaveError('');
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  async function saveFile() {
    if (!dirty() || saving() || file.data?.truncated) return !dirty();
    const content = draftContent();
    const mtimeMs = savedMtimeMs();
    const etag = savedEtag();
    const contentHash = savedContentHash();
    setSaving(true);
    setSaveError('');
    try {
      const saved = await api<ProjectFilePreview>(`/api/projects/${props.project.id}/file?path=${encodeURIComponent(props.path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, mtimeMs, etag, contentHash }),
      });
      setSavedContent(saved.content);
      setSavedMtimeMs(saved.mtimeMs);
      setSavedEtag(saved.etag);
      setSavedContentHash(saved.contentHash);
      if (draftContent() === content) setDraftContent(saved.content);
      queryClient.setQueryData(['file-preview', props.project.id, props.path], saved);
      invalidateProjectFileListQueries(props.project.id);
      return !dirty();
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not save file'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndClose() {
    if (await saveFile()) props.onClose();
  }

  function requestClose() {
    if (dirty()) {
      setConfirmClose(true);
      return;
    }
    props.onClose();
  }

  return (
    <div class="asset-preview-backdrop" onMouseDown={requestClose}>
      <div class="asset-preview-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div class="asset-preview-header">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</div>
            <div class="truncate text-sm font-medium">{props.path}</div>
            <Show when={saveError()} fallback={<Show when={file.data?.truncated} fallback={<Show when={dirty()}><div class="text-xs text-muted-foreground">Unsaved changes</div></Show>}><div class="text-xs text-muted-foreground">Large file preview is read-only because it was truncated.</div></Show>}>
              <div class="text-xs text-destructive">{saveError()}</div>
            </Show>
          </div>
          <button class="project-modal-close shrink-0" onClick={requestClose}><X class="size-4" /></button>
        </div>
        <div class="asset-preview-body">
          <Show when={isImagePath(props.path)}>
            <div class="asset-preview-media">
              <img class="asset-preview-image" src={assetUrl(props.project.id, props.path)} alt={props.path} />
            </div>
          </Show>
          <Show when={isVideoPath(props.path)}>
            <div class="asset-preview-media">
              <video class="asset-preview-video" src={assetUrl(props.project.id, props.path)} controls />
            </div>
          </Show>
          <Show when={isPdfPath(props.path)}>
            <iframe class="h-full w-full bg-background" src={assetUrl(props.project.id, props.path)} title={props.path} />
          </Show>
          <Show when={isText()}>
            <Show when={!file.isLoading} fallback={<div class="p-4 text-sm text-muted-foreground">Loading preview...</div>}>
              <Show when={file.error}>
                <div class="m-4 rounded-2xl bg-card p-4 text-sm text-destructive ring-1 ring-destructive/20">{errorMessage(file.error, 'Could not load preview')}</div>
              </Show>
              <Show when={file.data}>
                {(preview) => (
                  <div class="file-preview-code-wrap">
                    <Show when={preview().truncated}><div class="file-preview-notice">Preview truncated to keep the app responsive.</div></Show>
                    <CodePreview path={props.path} content={draftContent()} readOnly={Boolean(preview().truncated)} themeMode={props.themeMode} syntaxTheme={settings.data?.effective.syntaxHighlightTheme} syntaxThemeLight={settings.data?.effective.syntaxHighlightThemeLight} syntaxThemeDark={settings.data?.effective.syntaxHighlightThemeDark} onContent={setDraftContent} onSave={() => void saveFile()} />
                  </div>
                )}
              </Show>
            </Show>
          </Show>
          <Show when={!isImagePath(props.path) && !isVideoPath(props.path) && !isPdfPath(props.path) && !isText()}>
            <div class="m-4 rounded-2xl bg-card p-4 text-sm text-muted-foreground ring-1 ring-foreground/10">Preview is not available for this file type.</div>
          </Show>
        </div>
        <div class="asset-preview-footer">
          <button class="button-secondary" disabled={saving()} onClick={requestClose}>Close</button>
          <Show when={isText()}>
            <button class="button" disabled={!dirty() || saving() || file.data?.truncated} onClick={() => void saveFile()}>{saving() ? 'Saving...' : 'Save'}</button>
          </Show>
        </div>
      </div>
      <Show when={confirmClose()}>
        <UnsavedFileDialog saving={saving()} error={saveError()} onSave={() => void saveAndClose()} onDiscard={props.onClose} onCancel={() => setConfirmClose(false)} />
      </Show>
    </div>
  );
}

function UnsavedFileDialog(props: { saving: boolean; error: string; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.saving) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class="confirm-modal-backdrop" onMouseDown={(event) => { event.stopPropagation(); if (!props.saving) props.onCancel(); }}>
      <div class="confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">Unsaved changes</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">Save your changes before closing this file?</p>
        <Show when={props.error}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{props.error}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button class="button-secondary" disabled={props.saving} onClick={props.onCancel}>Cancel</button>
          <button class="button-danger" disabled={props.saving} onClick={props.onDiscard}>Discard</button>
          <button class="button" disabled={props.saving} onClick={props.onSave}>{props.saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function CodePreview(props: { path: string; content: string; readOnly?: boolean; themeMode: ResolvedThemeMode; syntaxTheme?: SyntaxHighlightTheme; syntaxThemeLight?: SyntaxHighlightTheme; syntaxThemeDark?: SyntaxHighlightTheme; onContent: (content: string) => void; onSave: () => void }) {
  let containerRef: HTMLDivElement | undefined;
  let monacoApi: MonacoApi | undefined;
  let editor: import('monaco-editor').editor.IStandaloneCodeEditor | undefined;
  let model: import('monaco-editor').editor.ITextModel | undefined;
  let latestContent = props.content;

  onMount(() => {
    let disposed = false;
    installMonacoWorker();
    void import('monaco-editor').then((monaco) => {
      if (disposed || !containerRef) return;
      monacoApi = monaco;
      defineMonacoPreviewThemes(monaco);
      model = monaco.editor.createModel(props.content, monacoLanguage(props.path), monaco.Uri.from({ scheme: 'file', path: `/${props.path}` }));
      editor = monaco.editor.create(containerRef, {
        model,
        readOnly: Boolean(props.readOnly),
        domReadOnly: Boolean(props.readOnly),
        theme: monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme),
        automaticLayout: true,
        largeFileOptimizations: true,
        minimap: { enabled: false },
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        renderValidationDecorations: 'off',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        folding: true,
        glyphMargin: false,
        lineNumbersMinChars: 4,
        wordWrap: 'off',
        padding: { top: 14, bottom: 14 },
        scrollbar: { useShadows: false, horizontal: 'auto', vertical: 'auto' },
      });
      editor.onDidChangeModelContent(() => props.onContent(model?.getValue() ?? ''));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, props.onSave);
    });
    onCleanup(() => {
      disposed = true;
      editor?.dispose();
      model?.dispose();
    });
  });

  createEffect(() => {
    if (props.content === latestContent) return;
    latestContent = props.content;
    if (model?.getValue() !== props.content) model?.setValue(props.content);
  });

  createEffect(() => {
    if (!editor) return;
    editor.updateOptions({ readOnly: Boolean(props.readOnly), domReadOnly: Boolean(props.readOnly) });
  });

  createEffect(() => {
    props.themeMode;
    props.syntaxTheme;
    props.syntaxThemeLight;
    props.syntaxThemeDark;
    if (!editor || !monacoApi) return;
    monacoApi.editor.setTheme(monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme));
  });

  return <div ref={containerRef} class="file-preview-editor" aria-label={`Preview of ${props.path}`} />;
}

let monacoWorkerInstalled = false;
let monacoClipboardFallbackInstalled = false;
let monacoClipboardFallbackText = '';

function installMonacoClipboardFallback() {
  if (monacoClipboardFallbackInstalled) return;
  monacoClipboardFallbackInstalled = true;

  const existingClipboard = (navigator as unknown as { clipboard?: Partial<Clipboard> }).clipboard;
  if (existingClipboard?.write && existingClipboard.writeText && existingClipboard.readText && existingClipboard.read) return;

  async function writeFallbackText(text: string) {
    monacoClipboardFallbackText = text;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      // Clipboard access can be unavailable on insecure origins.
    } finally {
      textarea.remove();
    }
  }

  if (!window.ClipboardItem) {
    class FallbackClipboardItem {
      readonly presentationStyle = 'unspecified';
      readonly types: string[];

      constructor(private readonly items: Record<string, Blob | string | PromiseLike<Blob | string>>) {
        this.types = Object.keys(items);
      }

      async getType(type: string) {
        const value = await this.items[type];
        return value instanceof Blob ? value : new Blob([value ?? ''], { type });
      }

      static supports() {
        return false;
      }
    }

    window.ClipboardItem = FallbackClipboardItem as unknown as typeof ClipboardItem;
  }

  const clipboardFallback = {
    write: existingClipboard?.write?.bind(existingClipboard) ?? (async (items: ClipboardItem[]) => {
      try {
        const blob = await items[0]?.getType('text/plain');
        if (blob) await writeFallbackText(await blob.text());
      } catch {
        // Ignore cancelled Monaco clipboard workaround promises.
      }
    }),
    writeText: existingClipboard?.writeText?.bind(existingClipboard) ?? writeFallbackText,
    read: existingClipboard?.read?.bind(existingClipboard) ?? (async () => []),
    readText: existingClipboard?.readText?.bind(existingClipboard) ?? (async () => monacoClipboardFallbackText),
  };

  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboardFallback });
  } catch {
    // Some browsers expose navigator.clipboard as non-configurable. Monaco will fall back to browser behavior there.
  }
}

function installMonacoWorker() {
  installMonacoClipboardFallback();
  if (monacoWorkerInstalled) return;
  (self as unknown as { MonacoEnvironment?: { getWorker: (_workerId: string, label: string) => Worker } }).MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };
  monacoWorkerInstalled = true;
}

function defineMonacoPreviewThemes(monaco: MonacoApi) {
  defineCatppuccinMonacoTheme(monaco, 'latte', {
    base: 'eff1f5', mantle: 'e6e9ef', surface0: 'ccd0da', overlay0: '9ca0b0', text: '4c4f69', subtext0: '6c6f85', blue: '1e66f5', lavender: '7287fd', sapphire: '209fb5', teal: '179299', green: '40a02b', yellow: 'df8e1d', peach: 'fe640b', red: 'd20f39', mauve: '8839ef', pink: 'ea76cb',
  }, 'vs');
  defineCatppuccinMonacoTheme(monaco, 'frappe', {
    base: '303446', mantle: '292c3c', surface0: '414559', overlay0: '737994', text: 'c6d0f5', subtext0: 'a5adce', blue: '8caaee', lavender: 'babbf1', sapphire: '85c1dc', teal: '81c8be', green: 'a6d189', yellow: 'e5c890', peach: 'ef9f76', red: 'e78284', mauve: 'ca9ee6', pink: 'f4b8e4',
  }, 'vs-dark');
  defineCatppuccinMonacoTheme(monaco, 'macchiato', {
    base: '24273a', mantle: '1e2030', surface0: '363a4f', overlay0: '6e738d', text: 'cad3f5', subtext0: 'a5adcb', blue: '8aadf4', lavender: 'b7bdf8', sapphire: '7dc4e4', teal: '8bd5ca', green: 'a6da95', yellow: 'eed49f', peach: 'f5a97f', red: 'ed8796', mauve: 'c6a0f6', pink: 'f5bde6',
  }, 'vs-dark');
  defineCatppuccinMonacoTheme(monaco, 'mocha', {
    base: '1e1e2e', mantle: '181825', surface0: '313244', overlay0: '6c7086', text: 'cdd6f4', subtext0: 'a6adc8', blue: '89b4fa', lavender: 'b4befe', sapphire: '74c7ec', teal: '94e2d5', green: 'a6e3a1', yellow: 'f9e2af', peach: 'fab387', red: 'f38ba8', mauve: 'cba6f7', pink: 'f5c2e7',
  }, 'vs-dark');
}

function defineCatppuccinMonacoTheme(monaco: MonacoApi, name: 'latte' | 'frappe' | 'macchiato' | 'mocha', palette: CatppuccinPalette, base: 'vs' | 'vs-dark') {
  monaco.editor.defineTheme(`pi-web-catppuccin-${name}`, {
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: palette.overlay0 },
      { token: 'keyword', foreground: palette.mauve },
      { token: 'number', foreground: palette.peach },
      { token: 'string', foreground: palette.green },
      { token: 'type', foreground: palette.yellow },
      { token: 'function', foreground: palette.blue },
      { token: 'variable', foreground: palette.text },
      { token: 'tag', foreground: palette.blue },
      { token: 'attribute.name', foreground: palette.yellow },
      { token: 'delimiter', foreground: palette.overlay0 },
    ],
    colors: {
      'editor.background': `#${palette.base}`,
      'editor.foreground': `#${palette.text}`,
      'editorLineNumber.foreground': `#${palette.overlay0}`,
      'editorLineNumber.activeForeground': `#${palette.subtext0}`,
      'editor.selectionBackground': `#${palette.surface0}`,
      'editor.inactiveSelectionBackground': `#${palette.mantle}`,
      'editorCursor.foreground': `#${palette.text}`,
      'editorWhitespace.foreground': `#${palette.surface0}`,
      'editorIndentGuide.background1': `#${palette.surface0}`,
      'editorIndentGuide.activeBackground1': `#${palette.overlay0}`,
      'editorGutter.background': `#${palette.base}`,
      'editor.lineHighlightBackground': '#00000000',
      'scrollbar.shadow': '#00000000',
    },
  });
}

function monacoPreviewThemeId(themeMode: ResolvedThemeMode, lightTheme?: SyntaxHighlightTheme, darkTheme?: SyntaxHighlightTheme, legacyTheme?: SyntaxHighlightTheme) {
  return monacoThemeId(themeMode === 'dark' ? darkTheme ?? legacyTheme ?? 'catppuccin-mocha' : lightTheme ?? legacyTheme ?? 'catppuccin-latte');
}

function monacoThemeId(theme: SyntaxHighlightTheme) {
  if (theme === 'catppuccin-latte') return 'pi-web-catppuccin-latte';
  if (theme === 'catppuccin-frappe') return 'pi-web-catppuccin-frappe';
  if (theme === 'catppuccin-macchiato') return 'pi-web-catppuccin-macchiato';
  if (theme === 'catppuccin-mocha') return 'pi-web-catppuccin-mocha';
  if (theme === 'vscode-light') return 'vs';
  return 'vs-dark';
}

function shikiSyntaxTheme(themeMode: ResolvedThemeMode, settings?: PiSettings): ShikiSyntaxTheme {
  const theme = themeMode === 'dark'
    ? settings?.syntaxHighlightThemeDark ?? settings?.syntaxHighlightTheme ?? 'catppuccin-mocha'
    : settings?.syntaxHighlightThemeLight ?? settings?.syntaxHighlightTheme ?? 'catppuccin-latte';
  if (theme === 'vscode-light') return 'light-plus';
  if (theme === 'vscode-dark') return 'dark-plus';
  return theme;
}

function monacoLanguage(filePath: string) {
  const lower = filePath.toLowerCase();
  if (/\.tsx$/.test(lower)) return 'typescript';
  if (/\.ts$/.test(lower)) return 'typescript';
  if (/\.jsx$/.test(lower)) return 'javascript';
  if (/\.js$/.test(lower)) return 'javascript';
  if (/\.(json|jsonc)$/.test(lower)) return 'json';
  if (/\.(html?|svelte|vue)$/.test(lower)) return 'html';
  if (/\.(css|scss|sass|less)$/.test(lower)) return 'css';
  if (/\.(md|mdx)$/.test(lower)) return 'markdown';
  if (/\.(ya?ml)$/.test(lower)) return 'yaml';
  if (/\.(xml|svg)$/.test(lower)) return 'xml';
  if (/\.py$/.test(lower)) return 'python';
  if (/\.rb$/.test(lower)) return 'ruby';
  if (/\.(sh|bash|zsh|env)$/.test(lower)) return 'shell';
  if (/\.(c|h)$/.test(lower)) return 'c';
  if (/\.(cc|cpp|hpp)$/.test(lower)) return 'cpp';
  if (/\.rs$/.test(lower)) return 'rust';
  if (/\.go$/.test(lower)) return 'go';
  if (/\.java$/.test(lower)) return 'java';
  if (/\.sql$/.test(lower)) return 'sql';
  return 'plaintext';
}

function SessionTreePanel(props: { project: Project; sessionId: string; selectedId?: string; resizing: boolean; onSelect: (selection?: TreeSelection) => void; onResizeStart: (event: PointerEvent) => void; onResizeKeyDown: (event: KeyboardEvent) => void; onResizeReset: () => void; onClose: () => void }) {
  const [search, setSearch] = createSignal('');
  const [filterMode, setFilterMode] = createSignal<TreeFilterMode>('default');
  const session = createQuery(() => ({
    queryKey: ['session-tree', props.project.id, props.sessionId],
    queryFn: ({ signal }) => api<SessionDetail>(`/api/projects/${props.project.id}/session?sessionId=${encodeURIComponent(props.sessionId)}`, { signal }),
    placeholderData: () => queryClient.getQueryData<SessionDetail>(['session', props.project.id, props.sessionId]),
    select: sessionTreeViewFromDetail,
    reconcile: 'id',
    staleTime: SESSION_DETAIL_CACHE_STALE_TIME_MS,
  }));
  const activePathIds = createMemo(() => new Set(session.data?.branch.map((entry) => entry.id) ?? []));
  const [collapsedIds, setCollapsedIds] = createSignal<Set<string>>(new Set());
  const [nodeMenu, setNodeMenu] = createSignal<TreeNodeMenuState>();
  const [labelEditor, setLabelEditor] = createSignal<LabelEditorState>();
  const [summaryTarget, setSummaryTarget] = createSignal<SessionEntry>();
  const [customSummaryTarget, setCustomSummaryTarget] = createSignal<SessionEntry>();
  const [summarizingId, setSummarizingId] = createSignal<string>();
  const [summaryError, setSummaryError] = createSignal('');
  const flatNodes = createMemo(() => flattenSessionTree(session.data?.tree ?? [], collapsedIds()));
  const filteredNodes = createMemo(() => filterTreeNodes(flatNodes(), search(), filterMode(), session.data?.leafId ?? null));

  function continueFrom(entry: SessionEntry) {
    setNodeMenu(undefined);
    props.onSelect(treeSelectionForEntry(entry, 'none'));
  }

  function toggleCollapsed(entry: SessionEntry) {
    setCollapsedIds((items) => {
      const next = new Set(items);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
  }

  function openNodeMenu(flatNode: FlatTreeNode, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu({
      entry: flatNode.node.entry,
      label: flatNode.node.label,
      hasChildren: flatNode.node.children.length > 0,
      collapsed: collapsedIds().has(flatNode.node.entry.id),
      x: event.clientX,
      y: event.clientY,
    });
  }

  function setEntryLabel(entry: SessionEntry, currentLabel?: string) {
    setNodeMenu(undefined);
    setLabelEditor({ entry, label: currentLabel });
  }

  async function updateEntryLabel(entryId: string, label: string | undefined) {
    const nextSession = await api<SessionDetail>(`/api/projects/${props.project.id}/session/label?sessionId=${encodeURIComponent(props.sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryId, label }),
    });
    queryClient.setQueryData(['session-tree', props.project.id, props.sessionId], nextSession);
    queryClient.setQueryData(['session', props.project.id, props.sessionId], nextSession);
    queryClient.invalidateQueries({ queryKey: ['sessions', props.project.id] });
  }

  function copyEntryId(entry: SessionEntry) {
    setNodeMenu(undefined);
    void copyText(entry.id).catch((error) => console.error('Could not copy entry ID', error));
  }

  function confirmSummary(entry: SessionEntry) {
    setNodeMenu(undefined);
    setSummaryError('');
    setSummaryTarget(entry);
  }

  function promptForSummary(entry: SessionEntry) {
    setNodeMenu(undefined);
    setSummaryError('');
    setCustomSummaryTarget(entry);
  }

  async function summarizeBranch(entry: SessionEntry, treeSummary: { mode: 'summary' | 'custom'; instructions?: string; replace?: boolean }) {
    setSummarizingId(entry.id);
    setSummaryError('');
    try {
      await api(`/api/projects/${props.project.id}/session/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, targetId: entry.id, treeSummary }),
      });
      setSummaryTarget(undefined);
      setCustomSummaryTarget(undefined);
      props.onSelect(undefined);
      await queryClient.invalidateQueries({ queryKey: ['session-tree', props.project.id, props.sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['session', props.project.id, props.sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['sessions', props.project.id] });
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : 'Could not summarize branch');
    } finally {
      setSummarizingId(undefined);
    }
  }

  return (
    <aside class="tool-panel tree-panel">
      <div
        class="side-panel-resize-handle"
        role="separator"
        aria-label="Resize session tree"
        aria-orientation="vertical"
        aria-valuemin={TREE_PANEL_MIN_WIDTH}
        tabIndex={0}
        data-dragging={props.resizing ? 'true' : 'false'}
        onDblClick={props.onResizeReset}
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
      />
      <div class="tool-panel-header">
        <div>
          <div class="font-semibold">Session tree</div>
          <div class="truncate text-xs text-muted-foreground">{session.data?.name || props.project.name}</div>
        </div>
        <button class="ghost" onClick={props.onClose}><X class="size-4" /></button>
      </div>
      <div class="grid min-h-0 grid-rows-[auto_1fr] gap-2 p-3">
        <div class="flex items-center gap-2">
          <input class="input h-8 min-w-0 flex-1" placeholder="Search tree" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
          <UiSelect compact class="w-44 shrink-0" value={filterMode()} onChange={(value) => setFilterMode(value as TreeFilterMode)} options={TREE_FILTER_OPTIONS} ariaLabel="Tree filter" />
          <span class="text-xs text-muted-foreground">{filteredNodes().length}</span>
        </div>
        <div class="session-tree-list">
          <Show when={!session.isLoading} fallback={<div class="p-2 text-muted-foreground">Loading tree...</div>}>
            <Show when={!session.error} fallback={<div class="p-2 text-destructive">{session.error instanceof Error ? session.error.message : 'Could not load tree'}</div>}>
              <Show when={filteredNodes().length} fallback={<div class="p-2 text-muted-foreground">No entries found</div>}>
                <For each={filteredNodes()}>
                  {(flatNode) => {
                    const entry = () => flatNode.node.entry;
                    const hasChildren = () => flatNode.node.children.length > 0;
                    const collapsed = () => collapsedIds().has(entry().id);
                    const isActiveLeaf = () => !props.selectedId && session.data?.leafId === entry().id;
                    const isSelected = () => props.selectedId === entry().id;
                    return (
                      <div
                        class={`tree-row group ${activePathIds().has(entry().id) ? 'tree-row-path' : ''} ${isActiveLeaf() ? 'tree-row-leaf' : ''} ${isSelected() ? 'tree-row-selected' : ''}`}
                        role="button"
                        tabIndex={0}
                        title="Select this entry"
                        onClick={() => continueFrom(entry())}
                        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') continueFrom(entry()); }}
                        onContextMenu={(event) => openNodeMenu(flatNode, event)}
                      >
                        <TreeIndent flatNode={flatNode} multipleRoots={(session.data?.tree.length ?? 0) > 1} />
                        <button
                          class={`tree-fold ${hasChildren() ? '' : 'tree-fold-empty'}`}
                          title={hasChildren() ? (collapsed() ? 'Expand' : 'Collapse') : undefined}
                          onClick={(event) => { event.stopPropagation(); if (hasChildren()) toggleCollapsed(entry()); }}
                        >
                          <Show when={hasChildren()} fallback={<span />}>{collapsed() ? <ChevronRight class="size-4" /> : <ChevronDown class="size-4" />}</Show>
                        </button>
                        <span class="tree-entry-icon"><TreeEntryIcon entry={entry()} /></span>
                        <Show when={flatNode.node.label}><span class="tree-label">{flatNode.node.label}</span></Show>
                        <span class={`tree-entry-text ${flatNode.node.roleClass}`}>{flatNode.node.display}</span>
                        <div class="ml-auto flex shrink-0 items-center gap-1">
                          <button class="tree-row-menu-button" title="Tree options" onClick={(event) => openNodeMenu(flatNode, event)}><Ellipsis class="size-4" /></button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
      <Show when={nodeMenu()}>
        {(menu) => (
          <TreeNodeMenu
            menu={menu()}
            onSummarize={confirmSummary}
            onSummarizeWithPrompt={promptForSummary}
            onToggleFold={(entry) => { setNodeMenu(undefined); toggleCollapsed(entry); }}
            onSetLabel={(entry, label) => setEntryLabel(entry, label)}
            onClearLabel={(entry) => updateEntryLabel(entry.id, undefined).then(() => setNodeMenu(undefined))}
            onCopyEntryId={copyEntryId}
            onDismiss={() => setNodeMenu(undefined)}
          />
        )}
      </Show>
      <Show when={labelEditor()}>
        {(editor) => (
          <EntryLabelDialog
            currentLabel={editor().label}
            onCancel={() => setLabelEditor(undefined)}
            onSave={async (label) => {
              await updateEntryLabel(editor().entry.id, label.trim() || undefined);
              setLabelEditor(undefined);
            }}
          />
        )}
      </Show>
      <Show when={summaryTarget()}>
        {(entry) => (
          <ConfirmDialog
            title="Summarize branch?"
            description={`Pi will navigate to "${treeEntryDisplay(entry())}" and summarize the branch being left behind.`}
            confirmLabel="Summarize"
            busyLabel="Summarizing..."
            variant="primary"
            busy={summarizingId() === entry().id}
            error={summaryError()}
            onCancel={() => { if (!summarizingId()) { setSummaryTarget(undefined); setSummaryError(''); } }}
            onConfirm={() => summarizeBranch(entry(), { mode: 'summary' })}
          />
        )}
      </Show>
      <Show when={customSummaryTarget()}>
        {(entry) => (
          <SummaryPromptDialog
            entry={entry()}
            busy={summarizingId() === entry().id}
            error={summaryError()}
            onCancel={() => { if (!summarizingId()) { setCustomSummaryTarget(undefined); setSummaryError(''); } }}
            onConfirm={(instructions, replace) => summarizeBranch(entry(), { mode: 'custom', instructions, replace })}
          />
        )}
      </Show>
    </aside>
  );
}

function TreeIndent(props: { flatNode: FlatTreeNode; multipleRoots: boolean }) {
  const guides = createMemo(() => {
    const displayIndent = treeDisplayIndent(props.flatNode, props.multipleRoots);
    const connectorPosition = props.flatNode.showConnector && !props.flatNode.isVirtualRootChild ? displayIndent - 1 : -1;
    return Array.from({ length: displayIndent }, (_, position) => {
      const gutter = props.flatNode.gutters.find((item) => item.position === position);
      const connector = position === connectorPosition ? (props.flatNode.isLast ? 'last' : 'branch') : undefined;
      return { gutter: Boolean(gutter?.show), connector };
    });
  });
  return (
    <span class="tree-indent" aria-hidden="true">
      <For each={guides()}>
        {(guide) => (
          <span
            class={`tree-indent-guide ${guide.gutter ? 'tree-indent-guide-active' : ''} ${guide.connector ? `tree-indent-guide-${guide.connector}` : ''}`}
          />
        )}
      </For>
    </span>
  );
}

function TreeNodeMenu(props: {
  menu: TreeNodeMenuState;
  onSummarize: (entry: SessionEntry) => void;
  onSummarizeWithPrompt: (entry: SessionEntry) => void;
  onToggleFold: (entry: SessionEntry) => void;
  onSetLabel: (entry: SessionEntry, label?: string) => void;
  onClearLabel: (entry: SessionEntry) => void;
  onCopyEntryId: (entry: SessionEntry) => void;
  onDismiss: () => void;
}) {
  createEffect(() => {
    const dismiss = () => props.onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onDismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  const margin = 8;
  const menuWidth = 288;
  const menuHeight = 280;
  const left = Math.max(margin, Math.min(props.menu.x, window.innerWidth - menuWidth - margin));
  const top = Math.max(margin, Math.min(props.menu.y, window.innerHeight - menuHeight - margin));

  return (
    <div class="project-menu tree-node-menu" style={{ left: `${left}px`, top: `${top}px` }} onMouseDown={(event) => event.stopPropagation()}>
      <button class="project-menu-item" onClick={() => props.onSummarize(props.menu.entry)}>Summarize branch</button>
      <button class="project-menu-item" onClick={() => props.onSummarizeWithPrompt(props.menu.entry)}>Summarize branch with prompt...</button>
      <div class="project-menu-divider" />
      <Show when={props.menu.hasChildren}>
        <button class="project-menu-item" onClick={() => props.onToggleFold(props.menu.entry)}>{props.menu.collapsed ? 'Expand branch' : 'Collapse branch'}</button>
      </Show>
      <button class="project-menu-item" onClick={() => props.onSetLabel(props.menu.entry, props.menu.label)}>{props.menu.label ? 'Edit label...' : 'Set label...'}</button>
      <Show when={props.menu.label}>
        <button class="project-menu-item" onClick={() => props.onClearLabel(props.menu.entry)}>Clear label</button>
      </Show>
      <div class="project-menu-divider" />
      <button class="project-menu-item" onClick={() => props.onCopyEntryId(props.menu.entry)}>Copy entry ID</button>
    </div>
  );
}

function SummaryPromptDialog(props: { entry: SessionEntry; busy?: boolean; error?: string; onConfirm: (instructions: string, replace: boolean) => void; onCancel: () => void }) {
  const [instructions, setInstructions] = createSignal('');
  const [replace, setReplace] = createSignal(false);

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = instructions().trim();
    if (value && !props.busy) props.onConfirm(value, replace());
  }

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !props.busy && props.onCancel()}>
      <form class="confirm-modal max-w-lg" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-base font-medium leading-none">Summarize branch with prompt</h2>
            <p class="mt-2 text-sm leading-6 text-muted-foreground">Pi will navigate to "{treeEntryDisplay(props.entry)}" and summarize the branch being left behind.</p>
          </div>
          <button type="button" class="project-modal-close" disabled={props.busy} onClick={props.onCancel}><X class="size-4" /></button>
        </div>
        <textarea
          class="mt-4 min-h-28 w-full resize-none rounded-xl border border-input bg-input/30 p-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="Focus the summary on files changed, decisions made, blockers, etc."
          value={instructions()}
          onInput={(event) => setInstructions(event.currentTarget.value)}
          autofocus
        />
        <CheckboxControl class="mt-3" checked={replace()} onChange={setReplace} label="Replace Pi's default summary prompt instead of adding focus instructions" />
        <Show when={props.error}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{props.error}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button class="button" disabled={props.busy || !instructions().trim()}>{props.busy ? 'Summarizing...' : 'Summarize'}</button>
        </div>
      </form>
    </div>
  );
}

function EntryLabelDialog(props: { currentLabel?: string; onSave: (label: string) => void | Promise<void>; onCancel: () => void }) {
  const [label, setLabel] = createSignal(props.currentLabel ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy()) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await props.onSave(label());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save label');
      setBusy(false);
    }
  }

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !busy() && props.onCancel()}>
      <form class="confirm-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">{props.currentLabel ? 'Edit label' : 'Set label'}</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">Labels make important tree entries easier to find.</p>
        <input class="input mt-4 h-10" value={label()} onInput={(event) => setLabel(event.currentTarget.value)} placeholder="Label" autofocus />
        <Show when={error()}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{error()}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" disabled={busy()} onClick={props.onCancel}>Cancel</button>
          <button class="button" disabled={busy()}>{busy() ? 'Saving...' : 'Save label'}</button>
        </div>
      </form>
    </div>
  );
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back to a temporary textarea below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command was rejected');
  } finally {
    document.body.removeChild(textarea);
  }
}

function FileExplorer(props: { project: Project; themeMode: ResolvedThemeMode; searchRequest: number; resizing: boolean; onResizeStart: (event: PointerEvent) => void; onResizeKeyDown: (event: KeyboardEvent) => void; onResizeReset: () => void; onClose: () => void }) {
  const [currentPath, setCurrentPath] = createSignal(fileExplorerPaths.get(props.project.id) ?? '');
  const [selectedFile, setSelectedFile] = createSignal<string>();
  const [previewPath, setPreviewPath] = createSignal<string>();
  const [entryMenu, setEntryMenu] = createSignal<FileEntryMenuState>();
  const [renameTarget, setRenameTarget] = createSignal<FileEntryMenuState>();
  const [deleteTarget, setDeleteTarget] = createSignal<FileEntryMenuState>();
  const [createFileDir, setCreateFileDir] = createSignal<string>();
  const [fileSearchOpen, setFileSearchOpen] = createSignal(false);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal('');
  const files = createQuery(() => ({
    queryKey: ['files', props.project.id, currentPath()],
    queryFn: ({ signal }) => api<ProjectFilesResponse>(`/api/projects/${props.project.id}/files?path=${encodeURIComponent(currentPath())}`, { signal }),
    staleTime: 0,
    refetchOnWindowFocus: true,
  }));

  createEffect(() => {
    const projectId = props.project.id;
    setCurrentPath(fileExplorerPaths.get(projectId) ?? '');
    setSelectedFile(undefined);
    setPreviewPath(undefined);
    setEntryMenu(undefined);
    setRenameTarget(undefined);
    setDeleteTarget(undefined);
    setCreateFileDir(undefined);
    setFileSearchOpen(false);
  });

  createEffect(() => {
    if (props.searchRequest) setFileSearchOpen(true);
  });

  createEffect(() => {
    fileExplorerPaths.set(props.project.id, currentPath());
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = shortcutTargetElement(event);
      if (event.defaultPrevented || event.isComposing || !matchBinding('searchFiles', event) || target?.closest('.terminal-host, .monaco-editor') || hasBlockingShortcutDialog()) return;
      event.preventDefault();
      setFileSearchOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function openFile(path: string) {
    setSelectedFile(path);
    setPreviewPath(path);
    rememberRecentFile(props.project.id, fileSearchEntryFromPath(path));
  }

  function openEntry(path: string, type: ProjectFileEntry['type']) {
    if (type === 'directory') {
      setCurrentPath(path);
      return;
    }
    openFile(path);
  }

  function openEntryMenu(entry: ProjectFileEntry, entryPath: string, event: MouseEvent) {
    event.stopPropagation();
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : { left: event.clientX, bottom: event.clientY };
    setEntryMenu({ path: entryPath, name: entry.name, type: entry.type, x: rect.left, y: rect.bottom + 6 });
  }

  function invalidateFileExplorerQueries() {
    invalidateProjectFileQueries(props.project.id);
  }

  async function renameEntry(target: FileEntryMenuState, name: string) {
    const renamed = await api<{ path: string; name: string; type: ProjectFileEntry['type'] }>(`/api/projects/${props.project.id}/file?path=${encodeURIComponent(target.path)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (selectedFile() === target.path) setSelectedFile(renamed.path);
    else if (selectedFile()?.startsWith(`${target.path}/`)) setSelectedFile(`${renamed.path}${selectedFile()!.slice(target.path.length)}`);
    if (previewPath() === target.path) setPreviewPath(renamed.path);
    else if (previewPath()?.startsWith(`${target.path}/`)) setPreviewPath(`${renamed.path}${previewPath()!.slice(target.path.length)}`);
    invalidateFileExplorerQueries();
    setRenameTarget(undefined);
  }

  async function createFile(name: string, directory: string) {
    const created = await api<{ path: string; name: string; type: ProjectFileEntry['type'] }>(`/api/projects/${props.project.id}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, directory }),
    });
    setCurrentPath(parentPath(created.path));
    openFile(created.path);
    invalidateFileExplorerQueries();
    setCreateFileDir(undefined);
  }

  async function deleteEntry(target: FileEntryMenuState) {
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api(`/api/projects/${props.project.id}/file?path=${encodeURIComponent(target.path)}`, { method: 'DELETE' });
      if (selectedFile() === target.path || selectedFile()?.startsWith(`${target.path}/`)) setSelectedFile(undefined);
      if (previewPath() === target.path || previewPath()?.startsWith(`${target.path}/`)) setPreviewPath(undefined);
      invalidateFileExplorerQueries();
      setDeleteTarget(undefined);
    } catch (error) {
      setDeleteError(errorMessage(error, 'Could not delete file'));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <aside class="tool-panel file-explorer-panel">
      <div
        class="side-panel-resize-handle"
        role="separator"
        aria-label="Resize file explorer"
        aria-orientation="vertical"
        aria-valuemin={FILE_EXPLORER_MIN_WIDTH}
        tabIndex={0}
        data-dragging={props.resizing ? 'true' : 'false'}
        onDblClick={props.onResizeReset}
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
      />
      <div class="tool-panel-header">
        <div class="min-w-0 flex-1">
          <div class="font-semibold">Explorer</div>
          <div class="truncate text-xs text-muted-foreground">{currentPath() || props.project.name}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button class="ghost" title="Go to project root" disabled={!currentPath()} onClick={() => setCurrentPath('')}><Home class="size-4" /></button>
          <button class="ghost" title={`Search files (${formatBinding(getShortcutBinding('searchFiles'))})`} onClick={() => setFileSearchOpen(true)}><Search class="size-4" /></button>
          <button class="ghost" title="Create file in current folder" onClick={() => setCreateFileDir(currentPath())}><FilePlus class="size-4" /></button>
          <button class="ghost" title="Close file explorer" onClick={props.onClose}><X class="size-4" /></button>
        </div>
      </div>
      <div class="min-h-0 overflow-auto p-3">
        <Show when={currentPath()}>
          <button class="file-row mb-1" onClick={() => setCurrentPath(parentPath(currentPath()))}><CornerUpLeft class="size-4 shrink-0 text-muted-foreground" /><span>Parent folder</span></button>
        </Show>
        <Show when={files.isLoading}>
          <div class="file-explorer-state">Loading files...</div>
        </Show>
        <Show when={files.error}>
          <div class="file-explorer-state file-explorer-state-error">
            <div>{errorMessage(files.error, 'Could not list files')}</div>
            <button class="button-secondary mt-3 h-8 px-3 text-xs" onClick={() => void files.refetch()}>Retry</button>
          </div>
        </Show>
        <Show when={!files.isLoading && !files.error}>
          <Show when={(files.data?.entries.length ?? 0) > 0} fallback={<div class="file-explorer-state">This folder is empty.</div>}>
            <For each={files.data?.entries ?? []}>
              {(entry) => {
                const entryPath = () => joinRelativePath(currentPath(), entry.name);
                return (
                  <div class={`file-row file-row-entry ${selectedFile() === entryPath() ? 'file-row-active' : ''}`}>
                    <button class="file-row-main" onClick={() => openEntry(entryPath(), entry.type)}>
                      <span class="grid w-5 shrink-0 place-items-center">{entry.type === 'directory' ? <DirectoryTypeIcon name={entry.name} class="size-4" /> : <FileTypeIcon name={entry.name} class="size-4" />}</span>
                      <span class="truncate">{entry.name}</span>
                    </button>
                    <button class="file-row-menu-button" title={`${entry.type === 'directory' ? 'Folder' : 'File'} options`} onClick={(event) => openEntryMenu(entry, entryPath(), event)}><Ellipsis class="size-4" /></button>
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>
      </div>
      <Show when={entryMenu()}>
        {(menu) => (
          <FileEntryMenu
            menu={menu()}
            onCopyPath={(path) => { setEntryMenu(undefined); void copyText(absoluteProjectPath(props.project.path, path)); }}
            onCopyRelativePath={(path) => { setEntryMenu(undefined); void copyText(path); }}
            onRename={(target) => { setEntryMenu(undefined); setRenameTarget(target); }}
            onDelete={(target) => { setEntryMenu(undefined); setDeleteError(''); setDeleteTarget(target); }}
            onDismiss={() => setEntryMenu(undefined)}
          />
        )}
      </Show>
      <Show when={fileSearchOpen()}>
        <FileSearchModal project={props.project} onOpen={(path) => { setCurrentPath(parentPath(path)); openFile(path); }} onClose={() => setFileSearchOpen(false)} />
      </Show>
      <Show when={createFileDir() !== undefined}>
        <FileCreateDialog directory={createFileDir() ?? ''} onCancel={() => setCreateFileDir(undefined)} onConfirm={createFile} />
      </Show>
      <Show when={renameTarget()}>
        {(target) => <FileRenameDialog entry={target()} onCancel={() => setRenameTarget(undefined)} onConfirm={(name) => renameEntry(target(), name)} />}
      </Show>
      <Show when={deleteTarget()}>
        {(target) => (
          <ConfirmDialog
            title={`Permanently delete ${target().type === 'directory' ? 'folder' : 'file'}?`}
            description={`This will permanently delete "${target().path}". This cannot be undone.`}
            confirmLabel="Permanently delete"
            busyLabel="Deleting..."
            variant="danger"
            busy={deleteBusy()}
            error={deleteError()}
            onCancel={() => !deleteBusy() && setDeleteTarget(undefined)}
            onConfirm={() => void deleteEntry(target())}
          />
        )}
      </Show>
      <Show when={previewPath()}>
        {(path) => <AssetPreviewModal project={props.project} path={path()} themeMode={props.themeMode} onClose={() => setPreviewPath(undefined)} />}
      </Show>
    </aside>
  );
}

function FileEntryMenu(props: {
  menu: FileEntryMenuState;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onRename: (target: FileEntryMenuState) => void;
  onDelete: (target: FileEntryMenuState) => void;
  onDismiss: () => void;
}) {
  createEffect(() => {
    const dismiss = () => props.onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onDismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  const menuWidth = 220;
  const menuHeight = 186;
  const margin = 8;
  const left = Math.max(margin, Math.min(props.menu.x, window.innerWidth - menuWidth - margin));
  const top = Math.max(margin, Math.min(props.menu.y, window.innerHeight - menuHeight - margin));

  return (
    <div class="project-menu file-entry-menu" style={{ left: `${left}px`, top: `${top}px` }} onMouseDown={(event) => event.stopPropagation()}>
      <button class="project-menu-item" onClick={() => props.onCopyPath(props.menu.path)}>Copy path</button>
      <button class="project-menu-item" onClick={() => props.onCopyRelativePath(props.menu.path)}>Copy relative path</button>
      <div class="project-menu-divider" />
      <button class="project-menu-item" onClick={() => props.onRename(props.menu)}>Rename...</button>
      <button class="project-menu-item project-menu-item-danger" onClick={() => props.onDelete(props.menu)}>Permanently delete...</button>
    </div>
  );
}

function FileSearchModal(props: { project: Project; onOpen: (path: string) => void; onClose: () => void }) {
  let inputRef: HTMLInputElement | undefined;
  const [input, setInput] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [recentFiles, setRecentFiles] = createSignal(readRecentFiles(props.project.id));
  const searchValue = createMemo(() => input().trim());
  const showingRecent = createMemo(() => !searchValue() && recentFiles().length > 0);
  const fileSearch = createQuery(() => ({
    queryKey: ['file-search', props.project.id, query()],
    queryFn: ({ signal }) => api<{ files: ProjectFileSearchEntry[] }>(`/api/projects/${props.project.id}/files/search?query=${encodeURIComponent(query())}`, { signal }),
    enabled: !showingRecent(),
    staleTime: 15_000,
  }));
  const searching = createMemo(() => !showingRecent() && (fileSearch.isLoading || fileSearch.isFetching || query() !== searchValue()));
  const results = createMemo(() => showingRecent() ? recentFiles() : fileSearch.data?.files ?? []);

  onMount(() => inputRef?.focus());

  createEffect(() => {
    props.project.id;
    setRecentFiles(readRecentFiles(props.project.id));
  });

  createEffect(() => {
    const value = input().trim();
    const timeout = window.setTimeout(() => setQuery(value), FILE_SEARCH_DEBOUNCE_MS);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    query();
    setActiveIndex(0);
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function openFile(file: ProjectFileSearchEntry) {
    rememberRecentFile(props.project.id, file);
    setRecentFiles(readRecentFiles(props.project.id));
    props.onOpen(file.path);
    props.onClose();
  }

  function handleInputKeyDown(event: KeyboardEvent) {
    const files = results();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(files.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter' && files[activeIndex()]) {
      event.preventDefault();
      openFile(files[activeIndex()]);
    }
  }

  return (
    <div class="file-search-backdrop" onMouseDown={props.onClose}>
      <div class="file-search-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div class="file-search-input-wrap">
          <Search class="size-4 text-muted-foreground" />
          <input ref={inputRef} class="file-search-input" placeholder="Search files by name" value={input()} onInput={(event) => setInput(event.currentTarget.value)} onKeyDown={handleInputKeyDown} />
          <Show when={input()}><button class="ghost h-8 w-8 px-0" title="Clear search" onClick={() => setInput('')}><X class="size-3.5" /></button></Show>
        </div>
        <div class="file-search-results">
          <div class="file-search-section-label">{showingRecent() ? 'Recent files' : searchValue() ? 'Matching files' : 'Files'}</div>
          <Show when={!searching()} fallback={<div class="file-search-empty">Loading files...</div>}>
            <Show when={results().length > 0} fallback={<div class="file-search-empty">No matching files</div>}>
              <For each={results()}>
                {(file, index) => (
                  <button class={`file-search-result ${activeIndex() === index() ? 'file-search-result-active' : ''}`} onMouseEnter={() => setActiveIndex(index())} onClick={() => openFile(file)}>
                    <span class="grid w-5 shrink-0 place-items-center"><FileTypeIcon name={file.name} class="size-4" /></span>
                    <span class="min-w-0 flex-1 text-left">
                      <span class="block truncate text-sm">{highlightFileSearchText(file.name, input())}</span>
                      <span class="block truncate text-xs text-muted-foreground">{highlightFileSearchText(file.directory || props.project.name, input())}</span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function FileCreateDialog(props: { directory: string; onCancel: () => void; onConfirm: (name: string, directory: string) => void | Promise<void> }) {
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const normalizedDirectory = createMemo(() => props.directory.trim().replace(/\\/g, '/').replace(/^\.\/$/, ''));
  const valid = createMemo(() => Boolean(name().trim()) && !/[\\/]/.test(name().trim()));

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy()) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy()) return;
    setBusy(true);
    setError('');
    try {
      await props.onConfirm(name().trim(), normalizedDirectory());
    } catch (error) {
      setError(errorMessage(error, 'Could not create file'));
      setBusy(false);
    }
  }

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !busy() && props.onCancel()}>
      <form class="confirm-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">Create file</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">Create a file in the selected folder.</p>
        <div class="mt-4 rounded-2xl border border-border bg-muted/40 px-3 py-2">
          <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Relative path</div>
          <div class="mt-1 truncate text-sm text-foreground">{normalizedDirectory() || 'Project root'}</div>
        </div>
        <label class="settings-field mt-4">
          <span>Filename</span>
          <input class="input" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="example.ts" autofocus disabled={busy()} />
        </label>
        <Show when={error()}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{error()}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button class="button-secondary" type="button" disabled={busy()} onClick={props.onCancel}>Cancel</button>
          <button class="button" type="submit" disabled={!valid() || busy()}>{busy() ? 'Creating...' : 'Create file'}</button>
        </div>
      </form>
    </div>
  );
}

function FileRenameDialog(props: { entry: FileEntryMenuState; onCancel: () => void; onConfirm: (name: string) => void | Promise<void> }) {
  const [name, setName] = createSignal(props.entry.name);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const valid = createMemo(() => Boolean(name().trim()) && name().trim() !== props.entry.name && !/[\\/]/.test(name().trim()));

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy()) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy()) return;
    setBusy(true);
    setError('');
    try {
      await props.onConfirm(name().trim());
    } catch (error) {
      setError(errorMessage(error, 'Could not rename file'));
      setBusy(false);
    }
  }

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !busy() && props.onCancel()}>
      <form class="confirm-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <h2 class="text-base font-medium leading-none">Rename {props.entry.type === 'directory' ? 'folder' : 'file'}</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">Enter a new name for "{props.entry.path}".</p>
        <input class="input mt-4" value={name()} onInput={(event) => setName(event.currentTarget.value)} autofocus disabled={busy()} />
        <Show when={error()}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{error()}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button class="button-secondary" type="button" disabled={busy()} onClick={props.onCancel}>Cancel</button>
          <button class="button" type="submit" disabled={!valid() || busy()}>{busy() ? 'Renaming...' : 'Rename'}</button>
        </div>
      </form>
    </div>
  );
}

function GitCommitDialog(props: { stagedCount: number; busy: boolean; error: string; message?: string; onMessage?: (message: string) => void; onCancel: () => void; onConfirm: (message: string) => void | Promise<void> }) {
  const [uncontrolledMessage, setUncontrolledMessage] = createSignal(props.message ?? '');
  const message = () => props.message ?? uncontrolledMessage();
  const setMessage = (value: string) => {
    if (props.message === undefined) setUncontrolledMessage(value);
    props.onMessage?.(value);
  };
  const canSubmit = createMemo(() => Boolean(message().trim()) && props.stagedCount > 0 && !props.busy);

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit()) return;
    void props.onConfirm(message().trim());
  }

  return (
    <div class="confirm-modal-backdrop" onMouseDown={() => !props.busy && props.onCancel()}>
      <form class="confirm-modal max-w-lg" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-base font-medium leading-none">Commit staged changes</h2>
            <p class="mt-2 text-sm leading-6 text-muted-foreground">Write a commit message for {props.stagedCount} staged {props.stagedCount === 1 ? 'change' : 'changes'}.</p>
          </div>
          <button type="button" class="project-modal-close" disabled={props.busy} onClick={props.onCancel}><X class="size-4" /></button>
        </div>
        <textarea
          class="mt-4 min-h-28 w-full resize-none rounded-xl border border-input bg-input/30 p-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="Commit message"
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
          autofocus
          disabled={props.busy}
        />
        <Show when={props.error}>
          <div class="mt-4 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20">{props.error}</div>
        </Show>
        <div class="dialog-footer justify-end">
          <button type="button" class="button-secondary" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button class="button" disabled={!canSubmit()}>{props.busy ? 'Committing...' : 'Commit'}</button>
        </div>
      </form>
    </div>
  );
}

function ReviewWorkspace(props: { project: Project; state: ReviewWorkspaceState; themeMode: ResolvedThemeMode; onClose: () => void }) {
  let reviewSplitRef: HTMLDivElement | undefined;
  let fileListRef: HTMLDivElement | undefined;
  const sourceControlPanel = createResizableDimension({
    defaultSize: props.state.sourceControlWidth,
    minSize: REVIEW_SOURCE_CONTROL_MIN_WIDTH,
    maxSize: () => Math.max(REVIEW_SOURCE_CONTROL_MIN_WIDTH, (reviewSplitRef?.getBoundingClientRect().width ?? window.innerWidth) - REVIEW_PREVIEW_MIN_WIDTH),
    keyStep: REVIEW_SOURCE_CONTROL_RESIZE_KEY_STEP,
    axis: 'x',
    dragMultiplier: 1,
    increaseKey: 'ArrowRight',
    decreaseKey: 'ArrowLeft',
    cursor: 'ew-resize',
  });
  const [selected, setSelected] = createSignal<GitFileSelection | undefined>(props.state.selected);
  const [sourceControlOpen, setSourceControlOpen] = createSignal(props.state.sourceControlOpen);
  const [previewPath, setPreviewPath] = createSignal<string | undefined>(props.state.previewPath);
  const [stagedOpen, setStagedOpen] = createSignal(props.state.stagedOpen);
  const [unstagedOpen, setUnstagedOpen] = createSignal(props.state.unstagedOpen);
  let gitFileLongPressTimer: number | undefined;
  const [commitDialogOpen, setCommitDialogOpen] = createSignal(props.state.commitDialogOpen);
  const [commitMessage, setCommitMessage] = createSignal(props.state.commitMessage);
  const [commitBusy, setCommitBusy] = createSignal(false);
  const [commitError, setCommitError] = createSignal('');
  const [discardTarget, setDiscardTarget] = createSignal<GitFile>();
  const [actionMenu, setActionMenu] = createSignal<GitFileActionMenuState>();
  const [busyAction, setBusyAction] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  const status = createQuery(() => ({
    queryKey: ['git-status', props.project.id],
    queryFn: ({ signal }) => api<{ status: GitStatus }>(`/api/projects/${props.project.id}/git/status`, { signal }),
    refetchInterval: 10_000,
    staleTime: 5_000,
  }));
  const settings = createQuery(() => ({
    queryKey: ['settings', props.project.id],
    queryFn: ({ signal }) => api<PiSettingsResponse>(`/api/projects/${props.project.id}/settings`, { signal }),
    staleTime: SETTINGS_CACHE_STALE_TIME_MS,
  }));
  const [diffRefreshToken, setDiffRefreshToken] = createSignal(0);
  const [fileDiffState, setFileDiffState] = createSignal<ReviewFileDiffState>({ key: '', loading: false });
  const stagedFiles = createMemo(() => (status.data?.status.files ?? []).filter((file) => file.staged));
  const unstagedFiles = createMemo(() => (status.data?.status.files ?? []).filter((file) => file.unstaged));
  const canCommit = createMemo(() => stagedFiles().length > 0 && !commitBusy());
  const selectableFiles = createMemo<GitFileSelection[]>(() => [
    ...stagedFiles().map((file) => ({ path: file.path, staged: true })),
    ...unstagedFiles().map((file) => ({ path: file.path, staged: false })),
  ]);
  const selectedStatus = createMemo(() => (status.data?.status.files ?? []).find((file) => file.path === selected()?.path));
  const selectedDiffState = createMemo<ReviewFileDiffState>(() => {
    const current = selected();
    const state = fileDiffState();
    const key = reviewFileSelectionKey(current);
    return current && state.key === key ? state : { key, loading: Boolean(current) };
  });
  const selectedDiff = createMemo(() => selectedDiffState().data);

  function refreshSelectedDiff(options?: { force?: boolean }) {
    const current = selected();
    const state = fileDiffState();
    if (!current || (!options?.force && state.key === reviewFileSelectionKey(current) && state.loading)) return;
    setDiffRefreshToken((value) => value + 1);
  }

  onCleanup(() => {
    clearGitFileLongPress();
    if (fileListRef) saveFileListScroll(fileListRef);
  });

  createEffect(() => {
    if (!reviewSplitRef) return;
    const clampWidth = () => sourceControlPanel.setClampedSize(sourceControlPanel.size());
    const observer = new ResizeObserver(clampWidth);
    observer.observe(reviewSplitRef);
    window.addEventListener('resize', clampWidth);
    queueMicrotask(clampWidth);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', clampWidth);
    });
  });

  createEffect(() => {
    props.state.sourceControlWidth = sourceControlPanel.size();
  });

  createEffect(() => {
    if (!sourceControlOpen()) return;
    stagedOpen();
    unstagedOpen();
    stagedFiles().length;
    unstagedFiles().length;
    queueMicrotask(restoreFileListScroll);
  });

  createEffect(() => {
    const files = selectableFiles();
    const current = selected();
    if (!current || !status.data) return;
    if (files.some((file) => file.path === current.path && file.staged === current.staged)) return;
    setReviewSelected(files.find((file) => file.path === current.path));
  });

  createEffect(() => {
    const current = selected();
    diffRefreshToken();
    if (!current) {
      setFileDiffState({ key: '', loading: false });
      return;
    }

    const key = reviewFileSelectionKey(current);
    const controller = new AbortController();
    setFileDiffState((state) => (state.key === key ? { key, loading: true, data: state.data } : { key, loading: true }));
    api<GitFileDiff>(`/api/projects/${props.project.id}/git/file-diff?path=${encodeURIComponent(current.path)}&staged=${String(current.staged)}`, { signal: controller.signal })
      .then((diff) => {
        if (!controller.signal.aborted && reviewFileSelectionKey(selected()) === key) setFileDiffState({ key, loading: false, data: diff });
      })
      .catch((error) => {
        if (!controller.signal.aborted && reviewFileSelectionKey(selected()) === key) {
          setFileDiffState((state) => (state.key === key ? { key, loading: false, data: state.data, error } : { key, loading: false, error }));
        }
      });

    onCleanup(() => controller.abort());
  });

  createEffect(() => {
    if (!selected()) return;
    const refreshIfIdle = () => refreshSelectedDiff();
    const interval = window.setInterval(refreshIfIdle, 10_000);
    window.addEventListener('focus', refreshIfIdle);
    onCleanup(() => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfIdle);
    });
  });

  function saveFileListScroll(element: HTMLDivElement) {
    props.state.fileListScrollTop = element.scrollTop;
    props.state.fileListScrollLeft = element.scrollLeft;
  }

  function restoreFileListScroll() {
    if (!fileListRef) return;
    fileListRef.scrollTop = props.state.fileListScrollTop;
    fileListRef.scrollLeft = props.state.fileListScrollLeft;
  }

  function setReviewSelected(selection?: GitFileSelection) {
    if (reviewFileSelectionKey(selection) !== reviewFileSelectionKey(selected())) props.state.editorState = undefined;
    setSelected(selection);
    props.state.selected = selection;
  }

  function setReviewSourceControlOpen(open: boolean) {
    setSourceControlOpen(open);
    props.state.sourceControlOpen = open;
  }

  function setReviewPreviewPath(path?: string) {
    setPreviewPath(path);
    props.state.previewPath = path;
  }

  function setReviewCommitDialogOpen(open: boolean) {
    setCommitDialogOpen(open);
    props.state.commitDialogOpen = open;
  }

  function setReviewCommitMessage(message: string) {
    setCommitMessage(message);
    props.state.commitMessage = message;
  }

  function closeCommitDialog() {
    setReviewCommitDialogOpen(false);
    setReviewCommitMessage('');
    setCommitError('');
  }

  function setReviewStagedOpen(open: boolean) {
    setStagedOpen(open);
    props.state.stagedOpen = open;
  }

  function setReviewUnstagedOpen(open: boolean) {
    setUnstagedOpen(open);
    props.state.unstagedOpen = open;
  }

  function diffEditorViewState(path: string, staged: boolean) {
    const editorState = props.state.editorState;
    const key = reviewEditorStateKey(path, staged, 'diff');
    return editorState?.kind === 'diff' && editorState.key === key ? editorState.viewState : undefined;
  }

  function patchEditorViewState(path: string, staged: boolean) {
    const editorState = props.state.editorState;
    const key = reviewEditorStateKey(path, staged, 'patch');
    return editorState?.kind === 'patch' && editorState.key === key ? editorState.viewState : undefined;
  }

  function saveDiffEditorViewState(path: string, staged: boolean, viewState: ReviewDiffEditorViewState) {
    const current = selected();
    if (!current || current.path !== path || current.staged !== staged) return;
    props.state.editorState = { kind: 'diff', key: reviewEditorStateKey(path, staged, 'diff'), viewState };
  }

  function savePatchEditorViewState(path: string, staged: boolean, viewState: ReviewPatchEditorViewState) {
    const current = selected();
    if (!current || current.path !== path || current.staged !== staged) return;
    props.state.editorState = { kind: 'patch', key: reviewEditorStateKey(path, staged, 'patch'), viewState };
  }

  async function gitAction(action: 'stage' | 'unstage' | 'discard', file: string) {
    const actionKey = `${action}:${file}`;
    setBusyAction(actionKey);
    setActionError('');
    setCommitError('');
    try {
      const nextStatus = await api<{ status: GitStatus }>(`/api/projects/${props.project.id}/git/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) });
      queryClient.setQueryData(['git-status', props.project.id], nextStatus);
      refreshSelectedDiff({ force: true });
    } catch (error) {
      setActionError(errorMessage(error, `Git ${action} failed`));
    } finally {
      setBusyAction('');
    }
  }

  async function commitChanges(message: string) {
    const commitMessage = message.trim();
    if (!commitMessage || !canCommit()) return;
    setCommitBusy(true);
    setCommitError('');
    setActionError('');
    try {
      const nextStatus = await api<{ status: GitStatus }>(`/api/projects/${props.project.id}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: commitMessage }) });
      queryClient.setQueryData(['git-status', props.project.id], nextStatus);
      refreshSelectedDiff({ force: true });
      setReviewCommitDialogOpen(false);
      setReviewCommitMessage('');
    } catch (error) {
      setCommitError(errorMessage(error, 'Could not commit changes'));
    } finally {
      setCommitBusy(false);
    }
  }

  function refreshReview() {
    queryClient.invalidateQueries({ queryKey: ['git-status', props.project.id] });
    refreshSelectedDiff({ force: true });
  }

  function changeStats(file: GitFile, staged: boolean) {
    return {
      additions: staged ? file.stagedAdditions ?? file.additions ?? 0 : file.unstagedAdditions ?? file.additions ?? 0,
      deletions: staged ? file.stagedDeletions ?? file.deletions ?? 0 : file.unstagedDeletions ?? file.deletions ?? 0,
    };
  }

  function gitFileDisplayPath(file?: GitFile, staged = selected()?.staged) {
    if (!file) return selected()?.path ?? 'Select a changed file';
    return staged && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  }

  function selectFile(file: GitFile, staged: boolean) {
    setReviewSelected({ path: file.path, staged });
  }

  function clearGitFileLongPress() {
    if (gitFileLongPressTimer === undefined) return;
    window.clearTimeout(gitFileLongPressTimer);
    gitFileLongPressTimer = undefined;
  }

  function startGitFileLongPress(file: GitFile, staged: boolean, event: PointerEvent) {
    if (event.pointerType === 'mouse') return;
    clearGitFileLongPress();
    const { clientX, clientY } = event;
    gitFileLongPressTimer = window.setTimeout(() => {
      setActionMenu({ file, staged, x: clientX, y: clientY });
      selectFile(file, staged);
      gitFileLongPressTimer = undefined;
    }, 550);
  }

  function openGitFileMenu(file: GitFile, staged: boolean, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    clearGitFileLongPress();
    setActionMenu({ file, staged, x: event.clientX, y: event.clientY });
    selectFile(file, staged);
  }

  return (
    <section ref={reviewSplitRef} class={`review-workspace grid min-h-0 overflow-hidden bg-background ${sourceControlOpen() ? '' : 'review-source-hidden'}`} style={{ 'grid-template-columns': sourceControlOpen() ? `${sourceControlPanel.size()}px auto minmax(0,1fr)` : 'minmax(0,1fr)' }}>
      <Show when={sourceControlOpen()}>
        <>
          <aside id="review-source-control-panel" class="review-source-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-card">
        <div class="border-b border-border p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-semibold">Source control</div>
              <div class="truncate text-xs text-muted-foreground">{status.data?.status.branch ?? props.project.name}</div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button class="project-modal-close shrink-0" title="Refresh changes" onClick={refreshReview}><RefreshCw class="size-4" /></button>
              <button class="project-modal-close shrink-0 review-source-toggle-mobile" title="Hide changes" aria-label="Hide changes" aria-controls="review-source-control-panel" aria-expanded={sourceControlOpen()} onClick={() => setReviewSourceControlOpen(false)}><PanelLeftClose class="size-4" /></button>
              <button class="project-modal-close shrink-0 review-close-mobile" title="Close reviewer" onClick={props.onClose}><X class="size-4" /></button>
            </div>
          </div>
          <div class="mt-4 flex gap-2">
            <button class="button flex-1" type="button" disabled={!canCommit()} onClick={() => { setCommitError(''); setReviewCommitDialogOpen(true); }}>{commitBusy() ? 'Committing...' : 'Commit'}</button>
          </div>
          <Show when={actionError()}>
            <div class="mt-3 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive ring-1 ring-destructive/20">{actionError()}</div>
          </Show>
        </div>
        <div ref={fileListRef} class="review-file-list min-h-0 overflow-auto p-3" onScroll={(event) => saveFileListScroll(event.currentTarget)}>
          <PanelSection title={`Staged Changes ${stagedFiles().length}`} open={stagedOpen()} onOpenChange={setReviewStagedOpen}>
            <div class="space-y-1">
              <For each={stagedFiles()} fallback={<div class="review-empty-section">No staged changes.</div>}>
                {(file) => (
                  <div
                    class={`git-file-light group ${selected()?.path === file.path && selected()?.staged ? 'git-file-light-active' : ''} ${actionMenu()?.file.path === file.path && actionMenu()?.staged ? 'git-file-light-menu' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectFile(file, true)}
                    onContextMenu={(event) => openGitFileMenu(file, true, event)}
                    onPointerDown={(event) => startGitFileLongPress(file, true, event)}
                    onPointerMove={clearGitFileLongPress}
                    onPointerUp={clearGitFileLongPress}
                    onPointerCancel={clearGitFileLongPress}
                    onPointerLeave={clearGitFileLongPress}
                  >
                    <span class="git-file-status">{file.status}</span>
                    <span class="min-w-0 flex-1 truncate text-left" title={gitFileDisplayPath(file, true)}>{gitFileDisplayPath(file, true)}</span>
                    <span class="text-success">{changeStats(file, true).additions ? `+${changeStats(file, true).additions}` : ''}</span>
                    <span class="text-destructive">{changeStats(file, true).deletions ? `-${changeStats(file, true).deletions}` : ''}</span>
                    <div class="git-file-actions">
                      <button class="git-file-action" disabled={busyAction() === `unstage:${file.path}`} onClick={(event) => { event.stopPropagation(); void gitAction('unstage', file.path); }}>Unstage</button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </PanelSection>
          <PanelSection title={`Changes ${unstagedFiles().length}`} open={unstagedOpen()} onOpenChange={setReviewUnstagedOpen}>
            <div class="space-y-1">
              <For each={unstagedFiles()} fallback={<div class="review-empty-section">No working tree changes.</div>}>
                {(file) => (
                  <div
                    class={`git-file-light group ${selected()?.path === file.path && selected()?.staged === false ? 'git-file-light-active' : ''} ${actionMenu()?.file.path === file.path && actionMenu()?.staged === false ? 'git-file-light-menu' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectFile(file, false)}
                    onContextMenu={(event) => openGitFileMenu(file, false, event)}
                    onPointerDown={(event) => startGitFileLongPress(file, false, event)}
                    onPointerMove={clearGitFileLongPress}
                    onPointerUp={clearGitFileLongPress}
                    onPointerCancel={clearGitFileLongPress}
                    onPointerLeave={clearGitFileLongPress}
                  >
                    <span class="git-file-status">{file.status}</span>
                    <span class="min-w-0 flex-1 truncate text-left" title={gitFileDisplayPath(file, false)}>{gitFileDisplayPath(file, false)}</span>
                    <span class="text-success">{changeStats(file, false).additions ? `+${changeStats(file, false).additions}` : ''}</span>
                    <span class="text-destructive">{changeStats(file, false).deletions ? `-${changeStats(file, false).deletions}` : ''}</span>
                    <div class="git-file-actions">
                      <button class="git-file-action" disabled={busyAction() === `stage:${file.path}`} onClick={(event) => { event.stopPropagation(); void gitAction('stage', file.path); }}>Stage</button>
                      <button class="git-file-action git-file-action-danger" disabled={busyAction() === `discard:${file.path}`} onClick={(event) => { event.stopPropagation(); setDiscardTarget(file); }}>Discard</button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </PanelSection>
        </div>
      </aside>
      <div
        class="review-resize-handle"
        role="separator"
        aria-label="Resize source control panel"
        aria-orientation="vertical"
        aria-valuemin={REVIEW_SOURCE_CONTROL_MIN_WIDTH}
        aria-valuemax={sourceControlPanel.maxSize()}
        aria-valuenow={sourceControlPanel.size()}
        tabIndex={0}
        data-dragging={sourceControlPanel.resizing() ? 'true' : 'false'}
        onDblClick={() => sourceControlPanel.setClampedSize(REVIEW_SOURCE_CONTROL_DEFAULT_WIDTH)}
        onKeyDown={sourceControlPanel.resizeWithKeyboard}
        onPointerDown={sourceControlPanel.startResize}
      />
        </>
      </Show>
      <main class="grid min-h-0 min-w-0 grid-rows-[auto_1fr] overflow-hidden">
        <div class="review-preview-header">
          <div class="flex min-w-0 items-center gap-2">
            <Show when={!sourceControlOpen()}>
              <button class="project-modal-close shrink-0 review-source-toggle-mobile" title="Show changes" aria-label="Show changes" aria-controls="review-source-control-panel" aria-expanded={sourceControlOpen()} onClick={() => setReviewSourceControlOpen(true)}><PanelLeftOpen class="size-4" /></button>
            </Show>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <Show when={selected()} fallback={<div class="truncate text-sm font-medium">{gitFileDisplayPath(selectedStatus())}</div>}>
                  <button class="truncate text-sm font-medium text-left hover:underline" onClick={() => setReviewPreviewPath(selected()!.path)}>{gitFileDisplayPath(selectedStatus())}</button>
                  <button class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open file" onClick={() => setReviewPreviewPath(selected()!.path)}><ExternalLink class="size-3.5" /></button>
                </Show>
              </div>
              <div class="text-xs text-muted-foreground">{selected() ? (selected()?.staged ? 'Staged changes' : 'Working tree changes') : 'No preview open'}<Show when={selectedStatus()}> · {selectedStatus()?.status}</Show></div>
            </div>
          </div>
          <button class="project-modal-close shrink-0 review-close-desktop" title="Close reviewer" onClick={props.onClose}><X class="size-4" /></button>
        </div>
        <Show when={selected()} keyed fallback={<div class="review-preview-empty">Select a file to preview its staged or unstaged changes.</div>}>
          {(selection) => (
            <Show
              when={selectedDiff()}
              fallback={
                <div class={`review-preview-empty ${!selectedDiffState().loading && selectedDiffState().error ? 'text-destructive' : ''}`}>
                  {selectedDiffState().loading ? 'Loading diff...' : selectedDiffState().error ? errorMessage(selectedDiffState().error, 'Could not load diff') : 'No diff content available.'}
                </div>
              }
            >
              <ReviewFileDiffPreview
                selection={selection}
                diff={selectedDiff()!}
                themeMode={props.themeMode}
                syntaxTheme={settings.data?.effective.syntaxHighlightTheme}
                syntaxThemeLight={settings.data?.effective.syntaxHighlightThemeLight}
                syntaxThemeDark={settings.data?.effective.syntaxHighlightThemeDark}
                diffEditorViewState={diffEditorViewState}
                patchEditorViewState={patchEditorViewState}
                onDiffEditorViewStateChange={saveDiffEditorViewState}
                onPatchEditorViewStateChange={savePatchEditorViewState}
              />
            </Show>
          )}
        </Show>
      </main>
      <Show when={actionMenu()} keyed>
        {(menu) => (
          <GitFileActionMenu
            menu={menu}
            onDismiss={() => setActionMenu(undefined)}
            onAction={(action, file) => void gitAction(action, file)}
            onDiscard={setDiscardTarget}
          />
        )}
      </Show>
      <Show when={commitDialogOpen()}>
        <GitCommitDialog
          stagedCount={stagedFiles().length}
          busy={commitBusy()}
          error={commitError()}
          message={commitMessage()}
          onMessage={setReviewCommitMessage}
          onCancel={closeCommitDialog}
          onConfirm={commitChanges}
        />
      </Show>
      <Show when={discardTarget()} keyed>
        {(file) => (
          <ConfirmDialog
            title="Discard changes?"
            description={`${file.status.includes('?') ? 'This will permanently delete the untracked file' : 'This will permanently discard unstaged changes in'} "${file.path}". This cannot be undone.`}
            confirmLabel="Discard"
            variant="danger"
            onCancel={() => setDiscardTarget(undefined)}
            onConfirm={() => { const path = file.path; setDiscardTarget(undefined); void gitAction('discard', path); }}
          />
        )}
      </Show>
      <Show when={previewPath()} keyed>
        {(path) => <AssetPreviewModal project={props.project} path={path} themeMode={props.themeMode} onClose={() => setReviewPreviewPath(undefined)} />}
      </Show>
    </section>
  );
}

function ReviewFileDiffPreview(props: {
  selection: GitFileSelection;
  diff: GitFileDiff;
  themeMode: ResolvedThemeMode;
  syntaxTheme?: SyntaxHighlightTheme;
  syntaxThemeLight?: SyntaxHighlightTheme;
  syntaxThemeDark?: SyntaxHighlightTheme;
  diffEditorViewState: (path: string, staged: boolean) => ReviewDiffEditorViewState | undefined;
  patchEditorViewState: (path: string, staged: boolean) => ReviewPatchEditorViewState | undefined;
  onDiffEditorViewStateChange: (path: string, staged: boolean, viewState: ReviewDiffEditorViewState) => void;
  onPatchEditorViewStateChange: (path: string, staged: boolean, viewState: ReviewPatchEditorViewState) => void;
}) {
  return (
    <Show when={!props.diff.unavailable} fallback={<div class="review-preview-empty">{props.diff.message ?? 'Diff preview is not available for this file.'}</div>}>
      <Show
        when={props.diff.patch}
        fallback={
          <ReviewDiffEditor
            path={props.diff.path}
            original={props.diff.original}
            modified={props.diff.modified}
            viewStateKey={reviewEditorStateKey(props.diff.path, props.diff.staged, 'diff')}
            viewState={props.diffEditorViewState(props.diff.path, props.diff.staged)}
            onViewStateChange={(viewState) => props.onDiffEditorViewStateChange(props.selection.path, props.selection.staged, viewState)}
            themeMode={props.themeMode}
            syntaxTheme={props.syntaxTheme}
            syntaxThemeLight={props.syntaxThemeLight}
            syntaxThemeDark={props.syntaxThemeDark}
          />
        }
      >
        <div class="review-patch-preview">
          <Show when={props.diff.message}><div class="review-patch-message">{props.diff.message}</div></Show>
          <ReviewPatchEditor
            path={props.diff.path}
            patch={props.diff.patch ?? ''}
            viewStateKey={reviewEditorStateKey(props.diff.path, props.diff.staged, 'patch')}
            viewState={props.patchEditorViewState(props.diff.path, props.diff.staged)}
            onViewStateChange={(viewState) => props.onPatchEditorViewStateChange(props.selection.path, props.selection.staged, viewState)}
            themeMode={props.themeMode}
            syntaxTheme={props.syntaxTheme}
            syntaxThemeLight={props.syntaxThemeLight}
            syntaxThemeDark={props.syntaxThemeDark}
          />
        </div>
      </Show>
    </Show>
  );
}

function GitFileActionMenu(props: { menu: GitFileActionMenuState; onDismiss: () => void; onAction: (action: 'stage' | 'unstage', file: string) => void; onDiscard: (file: GitFile) => void }) {
  const left = Math.max(8, Math.min(props.menu.x, window.innerWidth - 220));
  const top = Math.max(8, Math.min(props.menu.y, window.innerHeight - 140));
  const runAction = (action: 'stage' | 'unstage') => {
    props.onDismiss();
    props.onAction(action, props.menu.file.path);
  };
  const discard = () => {
    props.onDismiss();
    props.onDiscard(props.menu.file);
  };

  createEffect(() => {
    const dismiss = () => props.onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onDismiss();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <div class="project-menu git-file-menu" style={{ left: `${left}px`, top: `${top}px` }} onPointerDown={(event) => event.stopPropagation()}>
      <Show when={props.menu.staged} fallback={<button class="project-menu-item" onClick={() => runAction('stage')}>Stage</button>}>
        <button class="project-menu-item" onClick={() => runAction('unstage')}>Unstage</button>
      </Show>
      <Show when={!props.menu.staged}>
        <div class="project-menu-divider" />
        <button class="project-menu-item project-menu-item-danger" onClick={discard}>Discard changes</button>
      </Show>
    </div>
  );
}

function ReviewDiffEditor(props: { path: string; original: string; modified: string; viewStateKey: string; viewState?: ReviewDiffEditorViewState; onViewStateChange?: (viewState: ReviewDiffEditorViewState) => void; themeMode: ResolvedThemeMode; syntaxTheme?: SyntaxHighlightTheme; syntaxThemeLight?: SyntaxHighlightTheme; syntaxThemeDark?: SyntaxHighlightTheme }) {
  let containerRef: HTMLDivElement | undefined;
  let monacoApi: MonacoApi | undefined;
  let editor: import('monaco-editor').editor.IStandaloneDiffEditor | undefined;
  let originalModel: import('monaco-editor').editor.ITextModel | undefined;
  let modifiedModel: import('monaco-editor').editor.ITextModel | undefined;
  let currentPath = '';
  let appliedViewStateKey = '';
  const [sideBySide, setSideBySide] = createSignal(true);

  function saveViewState() {
    const viewState = editor?.saveViewState();
    if (viewState) props.onViewStateChange?.(viewState);
  }

  function resetViewState() {
    editor?.getOriginalEditor().setPosition({ lineNumber: 1, column: 1 });
    editor?.getModifiedEditor().setPosition({ lineNumber: 1, column: 1 });
    editor?.getOriginalEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    editor?.getModifiedEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  }

  function applyViewState() {
    if (!editor || appliedViewStateKey === props.viewStateKey) return;
    if (props.viewState) editor.restoreViewState(props.viewState);
    else resetViewState();
    appliedViewStateKey = props.viewStateKey;
  }

  function createModels(monaco: MonacoApi) {
    const previousOriginalModel = originalModel;
    const previousModifiedModel = modifiedModel;
    const modelId = String((reviewEditorModelSequence += 1));
    const nextOriginalModel = monaco.editor.createModel(props.original, monacoLanguage(props.path), monaco.Uri.from({ scheme: 'review-original', path: `/${props.path}`, query: modelId }));
    const nextModifiedModel = monaco.editor.createModel(props.modified, monacoLanguage(props.path), monaco.Uri.from({ scheme: 'review-modified', path: `/${props.path}`, query: modelId }));
    currentPath = props.path;
    appliedViewStateKey = '';
    originalModel = nextOriginalModel;
    modifiedModel = nextModifiedModel;
    editor?.setModel({ original: originalModel, modified: modifiedModel });
    previousOriginalModel?.dispose();
    previousModifiedModel?.dispose();
    applyViewState();
  }

  onMount(() => {
    let disposed = false;
    const mediaQuery = window.matchMedia('(min-width: 901px)');
    const updateLayoutMode = () => setSideBySide(mediaQuery.matches);
    updateLayoutMode();
    mediaQuery.addEventListener('change', updateLayoutMode);

    installMonacoWorker();
    void import('monaco-editor').then((monaco) => {
      if (disposed || !containerRef) return;
      monacoApi = monaco;
      defineMonacoPreviewThemes(monaco);
      editor = monaco.editor.createDiffEditor(containerRef, {
        readOnly: true,
        domReadOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide(),
        enableSplitViewResizing: true,
        theme: monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme),
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        renderValidationDecorations: 'off',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        folding: true,
        glyphMargin: false,
        lineNumbersMinChars: 4,
        wordWrap: 'off',
        scrollBeyondLastColumn: REVIEW_EDITOR_SCROLL_BEYOND_LAST_COLUMN,
        padding: { top: 14, bottom: 14 },
        scrollbar: { useShadows: false, horizontal: 'auto', vertical: 'auto' },
      });
      createModels(monaco);
    });

    onCleanup(() => {
      disposed = true;
      mediaQuery.removeEventListener('change', updateLayoutMode);
      saveViewState();
      editor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    });
  });

  createEffect(() => {
    const path = props.path;
    const original = props.original;
    const modified = props.modified;
    if (!monacoApi) return;
    if (!originalModel || !modifiedModel || currentPath !== path) {
      createModels(monacoApi);
      return;
    }
    if (originalModel.getValue() !== original) originalModel.setValue(original);
    if (modifiedModel.getValue() !== modified) modifiedModel.setValue(modified);
    applyViewState();
  });

  createEffect(() => {
    props.viewStateKey;
    props.viewState;
    applyViewState();
  });

  createEffect(() => {
    const renderSideBySide = sideBySide();
    if (!editor) return;
    editor.updateOptions({ renderSideBySide });
  });

  createEffect(() => {
    props.themeMode;
    props.syntaxTheme;
    props.syntaxThemeLight;
    props.syntaxThemeDark;
    if (!editor || !monacoApi) return;
    monacoApi.editor.setTheme(monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme));
  });

  return <div ref={containerRef} class="review-diff-editor" aria-label={`Diff preview of ${props.path}`} />;
}

function ReviewPatchEditor(props: { path: string; patch: string; viewStateKey: string; viewState?: ReviewPatchEditorViewState; onViewStateChange?: (viewState: ReviewPatchEditorViewState) => void; themeMode: ResolvedThemeMode; syntaxTheme?: SyntaxHighlightTheme; syntaxThemeLight?: SyntaxHighlightTheme; syntaxThemeDark?: SyntaxHighlightTheme }) {
  let containerRef: HTMLDivElement | undefined;
  let monacoApi: MonacoApi | undefined;
  let editor: import('monaco-editor').editor.IStandaloneCodeEditor | undefined;
  let model: import('monaco-editor').editor.ITextModel | undefined;
  let currentPath = '';
  let latestPatch = props.patch;
  let appliedViewStateKey = '';

  function saveViewState() {
    const viewState = editor?.saveViewState();
    if (viewState) props.onViewStateChange?.(viewState);
  }

  function resetViewState() {
    editor?.setPosition({ lineNumber: 1, column: 1 });
    editor?.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  }

  function applyViewState() {
    if (!editor || appliedViewStateKey === props.viewStateKey) return;
    if (props.viewState) editor.restoreViewState(props.viewState);
    else resetViewState();
    appliedViewStateKey = props.viewStateKey;
  }

  function createPatchModel(monaco: MonacoApi) {
    const previousModel = model;
    const modelId = String((reviewEditorModelSequence += 1));
    const nextModel = monaco.editor.createModel(props.patch, 'diff', monaco.Uri.from({ scheme: 'review-patch', path: `/${props.path}.diff`, query: modelId }));
    currentPath = props.path;
    latestPatch = props.patch;
    appliedViewStateKey = '';
    model = nextModel;
    editor?.setModel(model);
    previousModel?.dispose();
    applyViewState();
  }

  onMount(() => {
    let disposed = false;
    installMonacoWorker();
    void import('monaco-editor').then((monaco) => {
      if (disposed || !containerRef) return;
      monacoApi = monaco;
      defineMonacoPreviewThemes(monaco);
      createPatchModel(monaco);
      editor = monaco.editor.create(containerRef, {
        model,
        readOnly: true,
        domReadOnly: true,
        theme: monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme),
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        renderValidationDecorations: 'off',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        folding: true,
        glyphMargin: false,
        lineNumbersMinChars: 4,
        wordWrap: 'off',
        scrollBeyondLastColumn: REVIEW_EDITOR_SCROLL_BEYOND_LAST_COLUMN,
        padding: { top: 14, bottom: 14 },
        scrollbar: { useShadows: false, horizontal: 'auto', vertical: 'auto' },
      });
      applyViewState();
    });
    onCleanup(() => {
      disposed = true;
      saveViewState();
      editor?.dispose();
      model?.dispose();
    });
  });

  createEffect(() => {
    const path = props.path;
    const patch = props.patch;
    if (!monacoApi) return;
    if (!model || currentPath !== path) {
      createPatchModel(monacoApi);
      return;
    }
    if (patch !== latestPatch) {
      latestPatch = patch;
      if (model.getValue() !== patch) model.setValue(patch);
    }
    applyViewState();
  });

  createEffect(() => {
    props.viewStateKey;
    props.viewState;
    applyViewState();
  });

  createEffect(() => {
    props.themeMode;
    props.syntaxTheme;
    props.syntaxThemeLight;
    props.syntaxThemeDark;
    if (!editor || !monacoApi) return;
    monacoApi.editor.setTheme(monacoPreviewThemeId(props.themeMode, props.syntaxThemeLight, props.syntaxThemeDark, props.syntaxTheme));
  });

  return <div ref={containerRef} class="review-patch-editor" aria-label={`Patch preview of ${props.path}`} />;
}

function PanelSection(props: { title: string; children: JSX.Element; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <Collapsible
      class="review-panel-section"
      triggerClass="review-panel-trigger"
      title={<span>{props.title}</span>}
      defaultOpen
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      {props.children}
    </Collapsible>
  );
}

function UserMessage(props: { project: Project; parts: ChatContentPart[]; attachments?: UploadAsset[]; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string; onPreviewAttachment: (path: string) => void }) {
  return (
    <div class="chat-row chat-row-user">
      <div class="chat-user-message">
        <Show when={(props.attachments?.length ?? 0) > 0}>
          <ChatAttachmentPreviews project={props.project} attachments={props.attachments ?? []} onPreviewAttachment={props.onPreviewAttachment} />
        </Show>
        <div class="chat-bubble chat-bubble-user"><MessageParts parts={props.parts} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} /></div>
      </div>
    </div>
  );
}

function ChatAttachmentPreviews(props: { project: Project; attachments: UploadAsset[]; onPreviewAttachment: (path: string) => void }) {
  return (
    <div class="chat-attachments" aria-label="Attachments">
      <For each={props.attachments}>
        {(asset) => (
          <div class="chat-attachment-wrap">
            <button type="button" class={`chat-attachment ${isImagePath(asset.path) ? 'chat-attachment-image' : 'chat-attachment-document'}`} aria-label={`Preview ${uploadAssetLabel(asset)}`} onClick={() => props.onPreviewAttachment(asset.path)}>
              <Show when={isImagePath(asset.path)} fallback={<span class="chat-attachment-file"><FileTypeIcon name={asset.filename ?? asset.path} class="size-6" /><span>{uploadAssetLabel(asset)}</span></span>}>
                <img class="chat-attachment-thumb" src={assetUrl(props.project.id, asset.path)} alt="" />
              </Show>
            </button>
            <span class="chat-attachment-tooltip" role="tooltip">{uploadAssetLabel(asset)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function TranscriptEntry(props: { entry: SessionEntry; project: Project; hideThinking: boolean; toolOutputMode: ChatToolOutputMode; toolCalls: Map<string, ToolCallInfo>; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string; onPreviewAttachment: (path: string) => void }) {
  const role = () => entryRole(props.entry);
  const parts = createMemo(() => entryContentParts(props.entry, { hideThinking: props.hideThinking, toolOutputMode: props.toolOutputMode }));

  if (!shouldDisplayTranscriptEntry(props.entry, { hideThinking: props.hideThinking, toolOutputMode: props.toolOutputMode })) return null;

  if (props.entry.type === 'custom_message') {
    return <div class="chat-note"><div class="chat-note-label">{customMessageLabel(props.entry)}</div><MessageParts parts={parts()} compact syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} /></div>;
  }

  if (props.entry.type === 'model_change' || props.entry.type === 'thinking_level_change' || props.entry.type === 'label' || props.entry.type === 'session_info') {
    return <div class="chat-meta"><span>{role()}</span><span><RichText text={entryText(props.entry)} searchQuery={props.searchQuery} /></span></div>;
  }

  if (props.entry.type === 'compaction') {
    return (
      <Collapsible
        class="tool-card tool-card-compact"
        triggerClass="tool-card-title tool-line-summary"
        title={(
          <>
            <span class="tool-line-label">Compaction</span>
            <span class="tool-line-text">{Math.round(Number(props.entry.tokensBefore ?? 0) / 1000)}k tokens</span>
          </>
        )}
      >
        <div class="tool-line-details whitespace-pre-wrap"><RichText text={contentText(props.entry.summary)} searchQuery={props.searchQuery} /></div>
      </Collapsible>
    );
  }

  if (props.entry.type === 'branch_summary') {
    return (
      <Collapsible
        class="tool-card tool-card-compact"
        triggerClass="tool-card-title tool-line-summary"
        title={(
          <>
            <span class="tool-line-label">Branch Summary</span>
            <span class="tool-line-text">{singleLine(contentText(props.entry.summary))}</span>
          </>
        )}
      >
        <div class="tool-line-details whitespace-pre-wrap"><RichText text={contentText(props.entry.summary)} searchQuery={props.searchQuery} /></div>
      </Collapsible>
    );
  }

  if (isUserMessageEntry(props.entry)) {
    return <UserMessage project={props.project} parts={parts()} attachments={userMessageAttachments(props.entry)} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} onPreviewAttachment={props.onPreviewAttachment} />;
  }

  if (props.entry.type === 'message' && props.entry.message?.role === 'bashExecution') {
    const command = String(props.entry.message.command ?? 'command');
    const output = String(props.entry.message.output ?? '').trimEnd();
    return (
      <Collapsible
        class={`tool-card tool-card-compact ${toolToneClass('bash')}`}
        triggerClass="tool-card-title tool-line-summary"
        title={(
          <>
            <span class="tool-line-label">Shell</span>
            <span class="tool-line-text">{singleLine(command)}</span>
            <Show when={props.entry.message.excludeFromContext}><span class="tool-line-text">· hidden from context</span></Show>
            <Show when={typeof props.entry.message.exitCode === 'number'}><span class="tool-line-text">· exit {String(props.entry.message.exitCode)}</span></Show>
          </>
        )}
      >
        <div class="tool-line-details whitespace-pre-wrap"><RichText text={output || '(no output)'} searchQuery={props.searchQuery} /></div>
      </Collapsible>
    );
  }

  if (props.entry.type === 'message' && props.entry.message?.role === 'toolResult') {
    return (
      <Show when={props.toolOutputMode !== 'hidden'}>
        <Show
          when={props.toolOutputMode === 'compact'}
          fallback={<div class={`tool-card ${props.entry.message.isError ? 'tool-card-error' : ''} ${toolToneClass(String(props.entry.message.toolName ?? 'tool'))}`}><div class="tool-card-title">{String(props.entry.message.toolName ?? 'tool')} {props.entry.message.isError ? 'failed' : 'finished'}</div><MessageParts parts={parts()} compact syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} /></div>}
        >
          <ToolResultCard entry={props.entry} parts={parts()} toolCalls={props.toolCalls} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />
        </Show>
      </Show>
    );
  }

  if (props.entry.type === 'message' && props.entry.message?.role === 'assistant') {
    return <Show when={parts().length}><div class="assistant-message"><MessageParts parts={parts()} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} /></div></Show>;
  }

  return <div class="chat-meta"><span>{role()}</span><span><RichText text={entryText(props.entry)} searchQuery={props.searchQuery} /></span></div>;
}

function ToolResultCard(props: { entry: SessionEntry; parts: ChatContentPart[]; toolCalls: Map<string, ToolCallInfo>; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  const toolCall = () => {
    const id = typeof props.entry.message?.toolCallId === 'string' ? props.entry.message.toolCallId : undefined;
    return id ? props.toolCalls.get(id) : undefined;
  };
  const toolName = () => toolCall()?.name ?? String(props.entry.message?.toolName ?? 'tool');
  const action = () => formatToolAction(toolName(), toolCall()?.args ?? {});
  const preview = () => {
    if (!props.entry.message?.isError) return undefined;
    const line = contentText(props.entry.message?.content).split('\n').find((item) => item.trim())?.trim();
    return line && (line.length > 160 ? `${line.slice(0, 157)}...` : line);
  };
  return (
    <Collapsible
      class={`tool-card tool-card-compact ${props.entry.message?.isError ? 'tool-card-error' : ''} ${toolToneClass(toolName())}`}
      triggerClass="tool-card-title tool-line-summary"
      title={(
        <>
          <span class="tool-line-label">{props.entry.message?.isError ? `Failed ${action().label}` : action().label}</span>
          <span class="tool-line-text">{action().text}</span>
          <Show when={preview()}> <span class="tool-line-text">· {preview()}</span></Show>
        </>
      )}
    >
      <div class="tool-line-details"><MessageParts parts={props.parts} compact syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} /></div>
    </Collapsible>
  );
}

function RichText(props: { text: string; searchQuery?: string }) {
  return (
    <For each={richTextParts(props.text)}>
      {(part) => (
        <span class={part.kind === 'code' ? 'rich-code' : part.kind === 'file' ? 'rich-file' : part.kind === 'strong' ? 'font-semibold' : ''}>
          <SearchHighlightedText text={part.text} searchQuery={props.searchQuery} />
        </span>
      )}
    </For>
  );
}

function SearchHighlightedText(props: { text: string; searchQuery?: string }) {
  return (
    <For each={searchHighlightParts(props.text, props.searchQuery)}>
      {(segment) => <Show when={segment.match} fallback={segment.text}><mark class="chat-search-highlight">{segment.text}</mark></Show>}
    </For>
  );
}

function InlinePlainText(props: { text: string; searchQuery?: string }) {
  return (
    <For each={plainRichTextParts(props.text)}>
      {(part) => (
        <span class={part.kind === 'file' ? 'rich-file' : part.kind === 'strong' ? 'font-semibold' : ''}>
          <SearchHighlightedText text={part.text} searchQuery={props.searchQuery} />
        </span>
      )}
    </For>
  );
}

function MarkdownContent(props: { text: string; compact?: boolean; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  const tokens = createMemo(() => markdownTokens(props.text));
  return (
    <div class={`markdown-content ${props.compact ? 'markdown-content-compact' : ''}`}>
      <For each={tokens()}>{(token) => <MarkdownBlock token={token} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />}</For>
    </div>
  );
}

function markdownTokens(text: string): Token[] {
  try {
    return Array.from(lexer(text, { gfm: true, breaks: true })).filter((token) => token.type !== 'space' && token.type !== 'def');
  } catch {
    return [{ type: 'text', raw: text, text } as Token];
  }
}

function MarkdownBlock(props: { token: Token; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }): JSX.Element {
  const token = props.token as MarkdownToken;
  if (token.type === 'heading') {
    return <MarkdownHeading depth={token.depth ?? 1}><MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} /></MarkdownHeading>;
  }
  if (token.type === 'paragraph') return <p><MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} /></p>;
  if (token.type === 'text') return <p><MarkdownInline tokens={token.tokens} text={token.text ?? token.raw ?? ''} searchQuery={props.searchQuery} /></p>;
  if (token.type === 'code') return <MarkdownCodeBlock code={token.text ?? ''} info={token.lang} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />;
  if (token.type === 'blockquote') {
    return (
      <blockquote class="markdown-blockquote">
        <Show when={token.tokens?.length} fallback={<p><InlinePlainText text={token.text ?? ''} searchQuery={props.searchQuery} /></p>}>
          <For each={token.tokens}>{(child) => <MarkdownBlock token={child} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />}</For>
        </Show>
      </blockquote>
    );
  }
  if (token.type === 'list') return <MarkdownList token={token} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />;
  if (token.type === 'table') {
    return (
      <div class="markdown-table-wrap">
        <table class="markdown-table">
          <Show when={(token.header?.length ?? 0) > 0}>
            <thead>
              <tr>
                <For each={token.header ?? []}>
                  {(cell, index) => <th class={markdownAlignClass(token.align?.[index()] ?? cell.align)}><MarkdownTableCellContent cell={cell} searchQuery={props.searchQuery} /></th>}
                </For>
              </tr>
            </thead>
          </Show>
          <tbody>
            <For each={token.rows ?? []}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell, index) => <td class={markdownAlignClass(token.align?.[index()] ?? cell.align)}><MarkdownTableCellContent cell={cell} searchQuery={props.searchQuery} /></td>}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    );
  }
  if (token.type === 'hr') return <hr class="markdown-hr" />;
  if (token.type === 'html') return <p><InlinePlainText text={token.raw ?? token.text ?? ''} searchQuery={props.searchQuery} /></p>;
  if (token.type === 'space' || token.type === 'def') return null;
  return <p><MarkdownInline tokens={token.tokens} text={token.text ?? token.raw ?? ''} searchQuery={props.searchQuery} /></p>;
}

function MarkdownHeading(props: { depth: number; children: JSX.Element }) {
  if (props.depth === 1) return <h1>{props.children}</h1>;
  if (props.depth === 2) return <h2>{props.children}</h2>;
  if (props.depth === 3) return <h3>{props.children}</h3>;
  if (props.depth === 4) return <h4>{props.children}</h4>;
  if (props.depth === 5) return <h5>{props.children}</h5>;
  return <h6>{props.children}</h6>;
}

function MarkdownCodeBlock(props: { code: string; info?: string; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  const [highlightedLines, setHighlightedLines] = createSignal<ShikiToken[][]>();
  const [copied, setCopied] = createSignal(false);
  const fence = createMemo(() => codeFenceInfo(props.info));
  let highlightSeq = 0;
  let copyResetTimer: number | undefined;

  createEffect(() => {
    const code = props.code;
    const language = fence().language;
    const theme = props.syntaxTheme;
    const seq = ++highlightSeq;
    setHighlightedLines(undefined);
    if (code.length > CHAT_CODE_HIGHLIGHT_MAX_LENGTH) return;
    void highlightMarkdownCode(code, language, theme)
      .then((lines) => {
        if (seq === highlightSeq) setHighlightedLines(lines);
      })
      .catch(() => {
        if (seq === highlightSeq) setHighlightedLines(undefined);
      });
  });

  onCleanup(() => {
    if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
  });

  async function copyCode() {
    try {
      await writeClipboardText(props.code);
      setCopied(true);
      if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div class="markdown-code-frame">
      <div class="markdown-code-header">
        <span class="markdown-code-lang">{fence().label}</span>
        <button type="button" class="markdown-code-copy" onClick={() => void copyCode()} aria-label="Copy code block">
          <Show when={copied()} fallback={<Copy class="size-3.5" />}><Check class="size-3.5" /></Show>
          <span>{copied() ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre class="markdown-code-block"><code><Show when={highlightedLines()} fallback={<SearchHighlightedText text={props.code} searchQuery={props.searchQuery} />}>
        {(lines) => (
          <For each={lines()}>
            {(line) => (
              <span class="markdown-code-line">
                <For each={line}>
                  {(token) => <span style={shikiTokenStyle(token)}><SearchHighlightedText text={token.content} searchQuery={props.searchQuery} /></span>}
                </For>
              </span>
            )}
          </For>
        )}
      </Show></code></pre>
    </div>
  );
}

function MarkdownList(props: { token: MarkdownToken; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  const start = typeof props.token.start === 'number' ? props.token.start : undefined;
  const className = `markdown-list ${props.token.ordered ? 'markdown-list-ordered' : 'markdown-list-unordered'}`;
  return props.token.ordered ? (
    <ol class={className} start={start}>
      <For each={props.token.items ?? []}>{(item) => <MarkdownListItem item={item} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />}</For>
    </ol>
  ) : (
    <ul class={className}>
      <For each={props.token.items ?? []}>{(item) => <MarkdownListItem item={item} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />}</For>
    </ul>
  );
}

function MarkdownListItem(props: { item: MarkdownListItemToken; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  return (
    <li class={`markdown-list-item ${props.item.task ? 'markdown-task-item' : ''}`}>
      <Show when={props.item.task}><span class={`markdown-task-box ${props.item.checked ? 'markdown-task-box-checked' : ''}`}>{props.item.checked ? '✓' : ''}</span></Show>
      <div class="markdown-list-item-content">
        <Show when={props.item.tokens?.length} fallback={<InlinePlainText text={props.item.text ?? ''} searchQuery={props.searchQuery} />}>
          <For each={props.item.tokens}>{(child) => <MarkdownBlock token={child} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />}</For>
        </Show>
      </div>
    </li>
  );
}

function MarkdownInline(props: { tokens?: Token[]; text?: string; searchQuery?: string }): JSX.Element {
  if (!props.tokens?.length) return <InlinePlainText text={props.text ?? ''} searchQuery={props.searchQuery} />;
  return <For each={props.tokens}>{(token) => <MarkdownInlineToken token={token} searchQuery={props.searchQuery} />}</For>;
}

function MarkdownInlineToken(props: { token: Token; searchQuery?: string }): JSX.Element {
  const token = props.token as MarkdownToken;
  if (token.type === 'text') {
    if (token.tokens?.length) return <MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} />;
    return <InlinePlainText text={token.text ?? token.raw ?? ''} searchQuery={props.searchQuery} />;
  }
  if (token.type === 'escape') return <InlinePlainText text={token.text ?? ''} searchQuery={props.searchQuery} />;
  if (token.type === 'codespan') return <code class="rich-code"><SearchHighlightedText text={token.text ?? ''} searchQuery={props.searchQuery} /></code>;
  if (token.type === 'strong') return <strong class="font-semibold"><MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} /></strong>;
  if (token.type === 'em') return <em><MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} /></em>;
  if (token.type === 'del') return <del><MarkdownInline tokens={token.tokens} text={token.text ?? ''} searchQuery={props.searchQuery} /></del>;
  if (token.type === 'br') return <br />;
  if (token.type === 'link') {
    const href = safeMarkdownUrl(token.href);
    const content = <MarkdownInline tokens={token.tokens} text={token.text ?? token.href ?? ''} searchQuery={props.searchQuery} />;
    if (!href) return content;
    const external = isExternalMarkdownUrl(href);
    return <a class="markdown-link" href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} title={token.title ?? undefined}>{content}</a>;
  }
  if (token.type === 'image') {
    const href = safeMarkdownUrl(token.href);
    const label = token.text ? `Image: ${token.text}` : 'Image';
    if (!href) return <span class="text-muted-foreground"><SearchHighlightedText text={label} searchQuery={props.searchQuery} /></span>;
    const external = isExternalMarkdownUrl(href);
    return <a class="markdown-link" href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} title={token.title ?? undefined}><SearchHighlightedText text={label} searchQuery={props.searchQuery} /></a>;
  }
  if (token.type === 'html') return <InlinePlainText text={token.raw ?? token.text ?? ''} searchQuery={props.searchQuery} />;
  return <InlinePlainText text={token.text ?? token.raw ?? ''} searchQuery={props.searchQuery} />;
}

function MarkdownTableCellContent(props: { cell: MarkdownTableCell; searchQuery?: string }) {
  return <MarkdownInline tokens={props.cell.tokens} text={props.cell.text ?? ''} searchQuery={props.searchQuery} />;
}

function markdownAlignClass(align?: 'center' | 'left' | 'right' | null) {
  if (align === 'center') return 'markdown-align-center';
  if (align === 'right') return 'markdown-align-right';
  return 'markdown-align-left';
}

function safeMarkdownUrl(href: string | undefined) {
  const trimmed = href?.trim();
  if (!trimmed || trimmed.startsWith('//')) return undefined;
  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) return undefined;
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/);
  if (scheme && !['http:', 'https:', 'mailto:'].includes(`${scheme[1]}:`)) return undefined;
  return trimmed;
}

function isExternalMarkdownUrl(href: string) {
  return /^(https?:|mailto:)/i.test(href);
}

let shikiHighlighterPromise: Promise<ShikiHighlighter> | undefined;

async function getShikiHighlighter() {
  shikiHighlighterPromise ??= import('shiki/bundle/full').then(({ createHighlighter }) => createHighlighter({ themes: [], langs: [] }));
  return shikiHighlighterPromise;
}

async function highlightMarkdownCode(code: string, language: string, theme: ShikiSyntaxTheme) {
  const highlighter = await getShikiHighlighter();
  if (!highlighter.getLoadedThemes().includes(theme)) await highlighter.loadTheme(theme as never);
  try {
    if (!isPlainShikiLanguage(language) && !highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage(language as never);
    return highlighter.codeToTokensBase(code, { lang: language as never, theme: theme as never }) as ShikiToken[][];
  } catch {
    return highlighter.codeToTokensBase(code, { lang: 'text' as never, theme: theme as never }) as ShikiToken[][];
  }
}

function codeFenceInfo(info?: string): CodeFenceInfo {
  const trimmed = info?.trim() ?? '';
  const rawLanguage = trimmed.split(/\s+/, 1)[0] ?? '';
  const filename = trimmed.match(/(?:^|\s)(?:filename|title|file)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const label = (filename?.[1] ?? filename?.[2] ?? filename?.[3] ?? rawLanguage) || 'text';
  return { label, language: normalizeShikiLanguage(rawLanguage) };
}

function normalizeShikiLanguage(language: string) {
  const normalized = language.trim().replace(/^\./, '').toLowerCase();
  if (!normalized || isPlainShikiLanguage(normalized)) return 'text';
  const aliases: Record<string, string> = {
    cjs: 'javascript',
    dockerfile: 'docker',
    golang: 'go',
    js: 'javascript',
    mjs: 'javascript',
    patch: 'diff',
    plaintext: 'text',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    shell: 'bash',
    shellscript: 'bash',
    sh: 'bash',
    ts: 'typescript',
    txt: 'text',
    yml: 'yaml',
    zsh: 'bash',
  };
  return aliases[normalized] ?? normalized;
}

function isPlainShikiLanguage(language: string) {
  return language === 'text' || language === 'txt' || language === 'plain' || language === 'plaintext';
}

function shikiTokenStyle(token: ShikiToken) {
  let style = token.color ? `color: ${token.color};` : '';
  if (token.fontStyle) {
    if (token.fontStyle & 1) style += 'font-style: italic;';
    if (token.fontStyle & 2) style += 'font-weight: 600;';
    if (token.fontStyle & 4) style += 'text-decoration: underline;';
  }
  return style || undefined;
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy failed');
  } finally {
    textarea.remove();
  }
}

function MessageParts(props: { parts: ChatContentPart[]; compact?: boolean; syntaxTheme: ShikiSyntaxTheme; searchQuery?: string }) {
  return (
    <div class={props.compact ? 'space-y-1' : 'space-y-3'}>
      <For each={props.parts.length ? props.parts : [{ type: 'text', text: '' } as ChatContentPart]}>
        {(part) => {
          if (part.type === 'thinking') {
            return <Collapsible class="thinking-block" triggerClass="thinking-trigger" title="Thinking"><div class="mt-2 whitespace-pre-wrap"><RichText text={part.text} searchQuery={props.searchQuery} /></div></Collapsible>;
          }
          if (part.type === 'text') return <MarkdownContent text={part.text} compact={props.compact} syntaxTheme={props.syntaxTheme} searchQuery={props.searchQuery} />;
          return <div class={`whitespace-pre-wrap ${part.type === 'error' ? 'text-destructive' : part.type === 'tool' || part.type === 'image' ? 'text-muted-foreground' : ''}`}><RichText text={part.text} searchQuery={props.searchQuery} /></div>;
        }}
      </For>
    </div>
  );
}

function LiveAgentActivity(props: { activity: AgentActivity; hideThinking: boolean; toolOutputMode: ChatToolOutputMode; syntaxTheme: ShikiSyntaxTheme }) {
  const error = createMemo(() => props.activity.error === 'Operation aborted' ? undefined : props.activity.error);
  const statusText = createMemo(() => {
    const retry = props.activity.retry;
    if (!retry) return props.activity.running ? 'working' : 'pi';
    const attempt = retry.attempt && retry.maxAttempts ? ` (${retry.attempt}/${retry.maxAttempts})` : retry.attempt ? ` (${retry.attempt})` : '';
    return `retrying${attempt}`;
  });
  return (
    <Show when={props.activity.running || error() || props.activity.notices.length}>
      <div class="live-agent">
        <div class="live-agent-header"><Show when={props.activity.running} fallback={<Bot class="size-3.5" />}><Show when={props.activity.retry} fallback={<LoaderCircle class="size-3.5 animate-spin" />}><RefreshCw class="size-3.5 animate-spin" /></Show></Show>{statusText()}<Show when={error()}><span class="text-destructive"> · {error()}</span></Show></div>
        <Show when={props.activity.text.trim()}><div class="assistant-message assistant-message-live"><MarkdownContent text={props.activity.text} syntaxTheme={props.syntaxTheme} /></div></Show>
        <Show when={!props.hideThinking && props.activity.thinking.trim()}><Collapsible class="thinking-block" triggerClass="thinking-trigger" title="Thinking" defaultOpen><div class="mt-2 whitespace-pre-wrap">{props.activity.thinking}</div></Collapsible></Show>
        <Show when={(props.toolOutputMode !== 'hidden' && props.activity.tools.length) || props.activity.notices.length}>
          <div class="live-agent-tools">
            <Show when={props.toolOutputMode !== 'hidden'}>
              <For each={props.activity.tools}>{(tool) => <LiveToolLine tool={tool} />}</For>
            </Show>
            <For each={props.activity.notices}>{(notice) => <div class="chat-meta"><span>agent</span><span>{notice}</span></div>}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function LiveShellActivity(props: { activity: BashActivity; command?: string }) {
  return (
    <Show when={props.command || props.activity.running || props.activity.error}>
      <div class={`tool-card tool-card-compact ${toolToneClass('bash')}`}>
        <div class="tool-card-title tool-line-summary">
          <span class="tool-line-label">Shell</span>
          <span class="tool-line-text">{singleLine(props.activity.command ?? props.command ?? 'command')}{props.activity.running || props.command ? '...' : ''}</span>
          <Show when={props.activity.error}><span class="tool-line-text text-destructive">· {props.activity.error}</span></Show>
        </div>
        <Show when={props.activity.output.trim()}>
          <div class="tool-line-details whitespace-pre-wrap">{props.activity.output.trimEnd()}</div>
        </Show>
      </div>
    </Show>
  );
}

function LiveToolLine(props: { tool: AgentToolActivity }) {
  const action = () => formatLiveToolAction(props.tool);
  return (
    <div class={`tool-card tool-card-compact ${props.tool.status === 'error' ? 'tool-card-error' : ''} ${toolToneClass(props.tool.name)}`}>
      <div class="tool-card-title tool-line-summary">
        <span class="tool-line-label">{props.tool.status === 'running' ? action().label : props.tool.status === 'error' ? `Failed ${action().label}` : action().label}</span>
        <span class="tool-line-text">{props.tool.status === 'running' ? `${action().text}...` : action().text}</span>
      </div>
    </div>
  );
}

function ToolSummary(props: { event: string }) {
  let parsed: { type?: string; message?: string; data?: unknown } = {};
  try { parsed = JSON.parse(props.event); } catch { parsed = { message: props.event }; }
  const summary = agentEventSummary(parsed);
  return <div class="mb-3 rounded-2xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10"><span class="font-medium text-foreground">{summary.label}</span><Show when={summary.text}> {summary.text}</Show></div>;
}

function shouldShowAgentEvent(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { type?: string; data?: unknown };
    if (parsed.type !== 'agent:event') return ['agent:start', 'agent:finish', 'agent:error', 'agent:notice', 'bash:start', 'bash:update', 'bash:finish', 'bash:error', 'error'].includes(parsed.type ?? '');
    const dataType = agentEventDataType(parsed.data);
    return ['agent_start', 'agent_end', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end'].includes(dataType ?? '');
  } catch {
    return true;
  }
}

function eventsBelongToSession(events: string[], sessionId: string) {
  return events.some((payload) => {
    try {
      return (JSON.parse(payload) as { sessionId?: string }).sessionId === sessionId;
    } catch {
      return false;
    }
  });
}

function agentEventSummary(event: { type?: string; message?: string; data?: unknown }) {
  if (event.type === 'agent:start') return { label: 'agent', text: 'started' };
  if (event.type === 'agent:finish') return { label: 'agent', text: 'finished' };
  if (event.type === 'agent:error') return { label: 'error', text: event.message ?? 'Agent failed' };
  if (event.type === 'agent:notice') return { label: 'notice', text: event.message };
  if (event.type !== 'agent:event') return { label: event.type ?? 'event', text: event.message };

  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const type = typeof data.type === 'string' ? data.type : 'event';
  const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
  if (type === 'agent_start') return { label: 'agent', text: 'started' };
  if (type === 'agent_end') return { label: 'agent', text: data.willRetry ? 'retry pending' : 'finished' };
  if (type === 'tool_execution_start') return { label: 'tool', text: `started ${toolName}` };
  if (type === 'tool_execution_end') return { label: data.isError ? 'tool error' : 'tool', text: `finished ${toolName}` };
  if (type === 'auto_retry_start') return { label: 'retry', text: `attempt ${data.attempt ?? ''} after ${data.errorMessage ?? 'provider error'}` };
  if (type === 'auto_retry_end') return { label: 'retry', text: data.success ? 'succeeded' : `failed ${data.finalError ?? ''}` };
  if (type === 'compaction_start') return { label: 'compaction', text: 'started' };
  if (type === 'compaction_end') return { label: 'compaction', text: data.aborted ? 'aborted' : 'finished' };
  return { label: 'agent', text: type.replace(/_/g, ' ') };
}

function agentEventDataType(data: unknown) {
  return data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string' ? (data as { type: string }).type : undefined;
}

function bashActivity(events: string[]): BashActivity {
  let running = false;
  let error: string | undefined;
  let command: string | undefined;
  let output = '';
  for (const raw of events) {
    let parsed: { type?: string; message?: string } = {};
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed.type === 'bash:start') {
      running = true;
      error = undefined;
      command = parsed.message;
      output = '';
      continue;
    }
    if (parsed.type === 'bash:update') {
      output += parsed.message ?? '';
      continue;
    }
    if (parsed.type === 'bash:finish') {
      running = false;
      command = parsed.message ?? command;
      continue;
    }
    if (parsed.type === 'bash:error') {
      running = false;
      error = parsed.message ?? 'Shell command failed';
    }
  }
  return { running, error, command, output };
}

function agentActivity(events: string[]): AgentActivity {
  let running = false;
  let error: string | undefined;
  let retry: AgentRetryActivity | undefined;
  let text = '';
  let thinking = '';
  const tools = new Map<string, AgentToolActivity>();
  const notices: string[] = [];

  for (const raw of events) {
    let parsed: { type?: string; message?: string; data?: unknown } = {};
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed.type === 'agent:start') {
      running = true;
      error = undefined;
      retry = undefined;
      text = '';
      thinking = '';
      tools.clear();
      notices.length = 0;
      continue;
    }
    if (parsed.type === 'agent:finish') {
      running = false;
      retry = undefined;
      continue;
    }
    if (parsed.type === 'agent:error' || parsed.type === 'error') {
      const message = parsed.message ?? 'Agent failed';
      if (/already processing/i.test(message) && running) {
        notices.push(message);
        continue;
      }
      running = false;
      retry = undefined;
      error = message === 'Request was aborted' ? 'Operation aborted' : message;
      continue;
    }
    if (parsed.type === 'agent:notice') {
      notices.push(parsed.message ?? 'notice');
      continue;
    }
    if (parsed.type !== 'agent:event' || !parsed.data || typeof parsed.data !== 'object') continue;
    const data = parsed.data as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'agent_start') {
      running = true;
      error = undefined;
      retry = undefined;
      text = '';
      thinking = '';
      tools.clear();
      notices.length = 0;
      continue;
    }
    if (type === 'agent_end') {
      running = data.willRetry === true;
      if (running) error = undefined;
      else retry = undefined;
      continue;
    }
    if (['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_retry_start', 'compaction_start'].includes(type)) running = true;
    if (type === 'message_update') {
      const event = data.assistantMessageEvent && typeof data.assistantMessageEvent === 'object' ? data.assistantMessageEvent as Record<string, unknown> : {};
      if (event.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'thinking_delta' && typeof event.delta === 'string') thinking += event.delta;
      if (event.type === 'text_end' && !text && typeof event.content === 'string') text = event.content;
      if (event.type === 'thinking_end' && !thinking && typeof event.content === 'string') thinking = event.content;
      continue;
    }
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
      const id = String(data.toolCallId ?? data.toolName ?? tools.size);
      const name = String(data.toolName ?? 'tool');
      const existing = tools.get(id);
      tools.set(id, {
        id,
        name,
        status: type === 'tool_execution_end' ? (data.isError ? 'error' : 'done') : 'running',
        summary: toolActivitySummary(data) ?? existing?.summary,
      });
      continue;
    }
    if (type === 'notice') notices.push(String(data.message ?? 'notice'));
    if (type === 'auto_retry_start') {
      const attempt = typeof data.attempt === 'number' && Number.isFinite(data.attempt) ? data.attempt : undefined;
      const maxAttempts = typeof data.maxAttempts === 'number' && Number.isFinite(data.maxAttempts) ? data.maxAttempts : undefined;
      const delayMs = typeof data.delayMs === 'number' && Number.isFinite(data.delayMs) ? data.delayMs : undefined;
      const errorMessage = String(data.errorMessage ?? 'provider error');
      const attemptText = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : attempt ? ` (${attempt})` : '';
      const delayText = delayMs ? ` in ${Math.ceil(delayMs / 1000)}s` : '';
      retry = { attempt, maxAttempts, delayMs, errorMessage };
      notices.push(`retrying${attemptText}${delayText} after ${errorMessage}`);
      continue;
    }
    if (type === 'auto_retry_end') {
      retry = undefined;
      notices.push(data.success ? 'retry succeeded' : `retry failed ${data.finalError ?? ''}`);
      if (data.success !== true) running = false;
      continue;
    }
    if (type === 'compaction_start') notices.push('compacting context');
    if (type === 'compaction_end') notices.push(data.aborted ? 'compaction aborted' : 'compaction finished');
  }

  return { running, error, text, thinking, tools: [...tools.values()], notices, retry };
}

function toolActivitySummary(data: Record<string, unknown>) {
  const args = data.args && typeof data.args === 'object' ? data.args : undefined;
  if (args && 'command' in args && typeof (args as { command?: unknown }).command === 'string') return (args as { command: string }).command;
  if (args && 'path' in args && typeof (args as { path?: unknown }).path === 'string') return (args as { path: string }).path;
  if (args && 'file_path' in args && typeof (args as { file_path?: unknown }).file_path === 'string') return (args as { file_path: string }).file_path;
  if (args) return JSON.stringify(args).slice(0, 160);
  return undefined;
}

function formatLiveToolAction(tool: AgentToolActivity) {
  if (tool.name === 'bash') return { label: 'Shell', text: singleLine(tool.summary ?? 'command') };
  if (tool.name === 'read') return { label: 'Read', text: shortPath(tool.summary ?? 'file') };
  if (tool.name === 'write') return { label: 'Write', text: shortPath(tool.summary ?? 'file') };
  if (tool.name === 'edit') return { label: 'Edit', text: shortPath(tool.summary ?? 'file') };
  if (tool.name === 'ls') return { label: 'List', text: shortPath(tool.summary ?? '.') };
  return { label: `Called \`${tool.name}\``, text: tool.summary ? singleLine(tool.summary) : 'none' };
}

function isUserMessageEntry(entry: SessionEntry) {
  return entry.type === 'message' && entry.message?.role === 'user';
}

function userMessageCount(entries: SessionEntry[]) {
  return entries.filter(isUserMessageEntry).length;
}

function chatDisplayEntries(entries: SessionEntry[]) {
  const firstUserIndex = entries.findIndex(isUserMessageEntry);
  return firstUserIndex > 0 ? entries.slice(firstUserIndex) : entries;
}

function shouldDisplayTranscriptEntry(entry: SessionEntry, options?: { hideThinking: boolean; toolOutputMode: ChatToolOutputMode }) {
  if (entry.type === 'custom') return false;
  if (entry.type === 'custom_message') return entry.display !== false && hasTextContent(entry.content);
  if (entry.type === 'label' || entry.type === 'session_info') return Boolean(entryText(entry).trim());
  if (entry.type === 'message' && entry.message?.role === 'assistant') {
    return entryContentParts(entry, options ?? { hideThinking: false, toolOutputMode: 'compact' }).length > 0;
  }
  if (entry.type === 'message' && entry.message?.role === 'toolResult') {
    return (options?.toolOutputMode ?? 'compact') !== 'hidden';
  }
  return true;
}

function customMessageLabel(entry: SessionEntry) {
  const customType = typeof entry.customType === 'string' ? entry.customType.trim() : '';
  return customType ? `context · ${customType}` : 'context';
}

function toolToneClass(name: string) {
  if (name === 'bash') return 'tool-tone-shell';
  if (name === 'read') return 'tool-tone-read';
  if (name === 'write') return 'tool-tone-write';
  if (name === 'edit') return 'tool-tone-edit';
  if (name === 'grep' || name === 'find') return 'tool-tone-search';
  if (name === 'ls') return 'tool-tone-list';
  return 'tool-tone-default';
}

function entryRole(entry: SessionEntry) {
  if (entry.type === 'message' && entry.message?.role === 'bashExecution') return 'shell';
  if (entry.type === 'message') return String(entry.message?.role ?? 'message');
  if (entry.type === 'custom_message') return String(entry.customType ?? 'custom');
  if (entry.type === 'thinking_level_change') return 'thinking';
  if (entry.type === 'model_change') return 'model';
  return entry.type.replace(/_/g, ' ');
}

function entryText(entry: SessionEntry) {
  if (entry.type === 'message' && entry.message?.role === 'bashExecution') return `${entry.message.excludeFromContext ? '!!' : '!'}${String(entry.message.command ?? '')}`;
  if (entry.type === 'message') return contentText(entry.message?.content);
  if (entry.type === 'custom_message') return contentText(entry.content);
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return contentText(entry.summary);
  if (entry.type === 'model_change') return [entry.provider, entry.modelId].filter(Boolean).join('/');
  if (entry.type === 'thinking_level_change') return contentText(entry.thinkingLevel);
  if (entry.type === 'label') return contentText(entry.label);
  if (entry.type === 'session_info') return contentText(entry.name);
  return contentText(entry.text ?? entry.content ?? entry.message ?? entry.summary ?? '');
}

function transcriptEntrySearchText(entry: SessionEntry, options: { hideThinking: boolean; toolOutputMode: ChatToolOutputMode }, toolCalls?: Map<string, ToolCallInfo>) {
  const partsText = entryContentParts(entry, options).map((part) => part.text).join('\n');
  if (entry.type === 'message' && entry.message?.role === 'bashExecution') {
    return [entry.message.excludeFromContext ? 'hidden from context' : '', String(entry.message.command ?? ''), String(entry.message.output ?? ''), partsText].filter(Boolean).join('\n');
  }
  if (entry.type === 'message' && entry.message?.role === 'toolResult') {
    if (options.toolOutputMode === 'hidden') return '';
    const id = typeof entry.message.toolCallId === 'string' ? entry.message.toolCallId : undefined;
    const toolCall = id ? toolCalls?.get(id) : undefined;
    const action = formatToolAction(toolCall?.name ?? String(entry.message.toolName ?? 'tool'), toolCall?.args ?? {});
    const argsText = toolCall && Object.keys(toolCall.args).length ? JSON.stringify(toolCall.args) : '';
    return [String(entry.message.toolName ?? ''), toolCall?.name, action.label, action.text, argsText, partsText].filter(Boolean).join('\n');
  }
  if (entry.type === 'custom_message') return [customMessageLabel(entry), partsText].filter(Boolean).join('\n');
  if (entry.type === 'model_change' || entry.type === 'thinking_level_change' || entry.type === 'label' || entry.type === 'session_info') return [entryRole(entry), partsText].filter(Boolean).join('\n');
  return partsText;
}

function normalizedSearchQuery(query: string) {
  return query.trim().toLowerCase();
}

function searchHighlightParts(text: string, query?: string) {
  const normalizedQuery = normalizedSearchQuery(query ?? '');
  if (!normalizedQuery) return text ? [{ text, match: false }] : [];
  const lowerText = text.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  while (index < text.length) {
    const matchIndex = lowerText.indexOf(normalizedQuery, index);
    if (matchIndex === -1) {
      parts.push({ text: text.slice(index), match: false });
      break;
    }
    if (matchIndex > index) parts.push({ text: text.slice(index, matchIndex), match: false });
    parts.push({ text: text.slice(matchIndex, matchIndex + normalizedQuery.length), match: true });
    index = matchIndex + normalizedQuery.length;
  }
  return parts.filter((part) => part.text);
}

function toolCallMap(entries: SessionEntry[]) {
  const calls = new Map<string, ToolCallInfo>();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (record.type !== 'toolCall' || typeof record.name !== 'string') continue;
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (!id) continue;
      const args = (record.arguments && typeof record.arguments === 'object' ? record.arguments : record.args && typeof record.args === 'object' ? record.args : {}) as Record<string, unknown>;
      calls.set(id, { id, name: record.name, args });
    }
  }
  return calls;
}

function formatToolAction(name: string, args: Record<string, unknown>) {
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
  if (name === 'read') return { label: 'Read', text: formatToolPath(path, args) };
  if (name === 'write') return { label: 'Write', text: formatToolPath(path, args) };
  if (name === 'edit') return { label: 'Edit', text: formatToolPath(path, args) };
  if (name === 'bash') return { label: 'Shell', text: singleLine(String(args.command ?? '')) || 'command' };
  if (name === 'grep') return { label: 'Search', text: `${String(args.pattern ?? '')}${path ? ` in ${shortPath(path)}` : ''}` };
  if (name === 'find') return { label: 'Find', text: `${String(args.pattern ?? '')}${path ? ` in ${shortPath(path)}` : ''}` };
  if (name === 'ls') return { label: 'List', text: shortPath(path || '.') };
  return { label: `Called \`${name}\``, text: Object.keys(args).length ? singleLine(JSON.stringify(args)) : 'none' };
}

function formatToolPath(path: string, args: Record<string, unknown>) {
  const base = shortPath(path || 'file');
  const offset = typeof args.offset === 'number' ? args.offset : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return base;
  const start = offset ?? 1;
  const end = limit === undefined ? '' : start + limit - 1;
  return `${base}:${start}${end ? `-${end}` : ''}`;
}

function shortPath(path: string) {
  if (!path) return path;
  const home = path.match(/^\/home\/[^/]+(\/.*)$/) ?? path.match(/^\/Users\/[^/]+(\/.*)$/);
  return home ? `~${home[1]}` : path;
}

function singleLine(text: string) {
  const line = text.replace(/[\n\t]+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function faviconStatusFromSummaries(summaries: WorkspaceNotificationSummary[]): FaviconStatus {
  if (summaries.some((summary) => summary.error)) return 'error';
  if (summaries.some((summary) => summary.running)) return 'running';
  if (summaries.some((summary) => summary.unread)) return 'unread';
  return 'idle';
}

const faviconStatusCache = new Map<FaviconStatus, string>();
let faviconBaseImagePromise: Promise<HTMLImageElement> | undefined;
let faviconUpdateId = 0;
let currentFaviconStatus: FaviconStatus | undefined;

function updateFaviconStatus(status: FaviconStatus) {
  if (currentFaviconStatus === status) return;
  currentFaviconStatus = status;
  const updateId = ++faviconUpdateId;

  if (status === 'idle') {
    setFaviconHref(FAVICON_HREF, 'image/svg+xml');
    return;
  }

  const cachedHref = faviconStatusCache.get(status);
  if (cachedHref) {
    setFaviconHref(cachedHref, 'image/png');
    return;
  }

  loadFaviconBaseImage()
    .then((image) => {
      if (updateId !== faviconUpdateId) return;
      const href = drawFaviconStatus(image, status);
      faviconStatusCache.set(status, href);
      setFaviconHref(href, 'image/png');
    })
    .catch(() => {
      if (updateId === faviconUpdateId) setFaviconHref(FAVICON_HREF, 'image/svg+xml');
    });
}

function setFaviconHref(href: string, type: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]') ?? document.head.appendChild(document.createElement('link'));
  link.rel = 'icon';
  link.type = type;
  link.href = href;
}

function loadFaviconBaseImage() {
  faviconBaseImagePromise ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load favicon'));
    image.src = FAVICON_HREF;
  });
  return faviconBaseImagePromise;
}

function drawFaviconStatus(image: HTMLImageElement, status: Exclude<FaviconStatus, 'idle'>) {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');

  context.drawImage(image, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
  drawFaviconBadge(context, status);
  return canvas.toDataURL('image/png');
}

function drawFaviconBadge(context: CanvasRenderingContext2D, status: Exclude<FaviconStatus, 'idle'>) {
  const { color, glyph } = FAVICON_BADGE_META[status];
  const x = 384;
  const y = 128;
  const radius = 112;

  context.save();
  context.shadowColor = 'rgb(0 0 0 / 0.45)';
  context.shadowBlur = 20;
  context.shadowOffsetY = 8;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.restore();

  context.save();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.lineWidth = 28;
  context.strokeStyle = '#fff7ed';
  context.stroke();
  context.restore();

  context.save();
  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ffffff';
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (glyph === 'play') {
    context.beginPath();
    context.moveTo(x - 32, y - 50);
    context.lineTo(x - 32, y + 50);
    context.lineTo(x + 58, y);
    context.closePath();
    context.fill();
  } else if (glyph === 'alert') {
    context.lineWidth = 28;
    context.beginPath();
    context.moveTo(x, y - 56);
    context.lineTo(x, y + 14);
    context.stroke();
    context.beginPath();
    context.arc(x, y + 62, 15, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.arc(x, y, 38, 0, Math.PI * 2);
    context.fill();
  }

  context.restore();
}

function workspaceNotificationState(state?: WorkspaceNotificationState): WorkspaceNotificationState {
  return {
    items: Array.isArray(state?.items) ? state.items : [],
    runningSessionIds: Array.isArray(state?.runningSessionIds) ? state.runningSessionIds : [],
  };
}

function workspaceNotificationSummary(state?: WorkspaceNotificationState): WorkspaceNotificationSummary {
  const normalized = workspaceNotificationState(state);
  return {
    total: normalized.items.length,
    unread: normalized.items.filter((item) => !item.read).length,
    running: normalized.runningSessionIds.length,
    error: normalized.items.some((item) => !item.read && item.level === 'error'),
    latest: normalized.items[0],
  };
}

function mergeWorkspaceNotificationSummaries(summaries: WorkspaceNotificationSummary[]): WorkspaceNotificationSummary {
  return {
    total: summaries.reduce((total, summary) => total + summary.total, 0),
    unread: summaries.reduce((total, summary) => total + summary.unread, 0),
    running: summaries.reduce((total, summary) => total + summary.running, 0),
    error: summaries.some((summary) => summary.error),
    latest: summaries.map((summary) => summary.latest).filter((item): item is WorkspaceNotificationItem => Boolean(item)).sort((a, b) => b.createdAt - a.createdAt)[0],
  };
}

function pruneWorkspaceNotificationState(state: WorkspaceNotificationState): WorkspaceNotificationState {
  return {
    items: [...state.items]
      .filter((item) => item && typeof item.id === 'string')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, WORKSPACE_NOTIFICATIONS_LIMIT),
    runningSessionIds: uniqueStrings(state.runningSessionIds).slice(0, 20),
  };
}

function readWorkspaceNotificationStore(): Record<string, WorkspaceNotificationState> {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_NOTIFICATIONS_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, WorkspaceNotificationState> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (!workspaceId || !value || typeof value !== 'object') continue;
      const record = value as { items?: unknown };
      const items = Array.isArray(record.items) ? record.items.map(readWorkspaceNotificationItem).filter((item): item is WorkspaceNotificationItem => Boolean(item)) : [];
      result[workspaceId] = { items: items.slice(0, WORKSPACE_NOTIFICATIONS_LIMIT), runningSessionIds: [] };
    }
    return result;
  } catch {
    return {};
  }
}

function writeWorkspaceNotificationStore(store: Record<string, WorkspaceNotificationState>) {
  const persisted = Object.fromEntries(Object.entries(store)
    .map(([workspaceId, state]) => [workspaceId, { items: pruneWorkspaceNotificationState(state).items }])
    .filter(([, state]) => (state as { items: WorkspaceNotificationItem[] }).items.length));
  localStorage.setItem(WORKSPACE_NOTIFICATIONS_KEY, JSON.stringify(persisted));
}

function readWorkspaceNotificationItem(value: unknown): WorkspaceNotificationItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.workspaceId !== 'string' || typeof record.title !== 'string' || typeof record.message !== 'string') return undefined;
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    title: record.title,
    message: record.message,
    level: isWorkspaceNotificationLevel(record.level) ? record.level : 'info',
    kind: isWorkspaceNotificationKind(record.kind) ? record.kind : 'notice',
    createdAt,
    read: Boolean(record.read),
  };
}

function workspaceNotificationFromEvent(event: WorkspaceNotificationServerEvent, workspaceId: string, read: boolean): WorkspaceNotificationItem | undefined {
  const createdAt = Date.now();
  const base = { id: `${workspaceId}:${event.sessionId ?? 'active'}:${event.type ?? 'event'}:${createdAt}:${Math.random().toString(36).slice(2, 7)}`, workspaceId, sessionId: event.sessionId, createdAt, read };
  if (event.type === 'agent:finish') return { ...base, title: 'Pi finished', message: 'Agent response completed.', level: 'success', kind: 'agent' };
  if (event.type === 'agent:error' || event.type === 'error') return { ...base, title: 'Pi failed', message: singleLine(event.message ?? 'Agent failed'), level: 'error', kind: 'agent' };
  if (event.type === 'agent:notice') return { ...base, title: 'Pi notice', message: singleLine(event.message ?? 'Notice'), level: notificationLevelFromUnknown((event.data as { level?: unknown } | undefined)?.level), kind: 'notice' };
  if (event.type === 'bash:finish') return { ...base, title: 'Command completed', message: singleLine(event.message ?? 'Shell command finished'), level: 'success', kind: 'command' };
  if (event.type === 'bash:error') return { ...base, title: 'Command failed', message: singleLine(event.message ?? 'Shell command failed'), level: 'error', kind: 'command' };
  if (event.type !== 'agent:event' || !event.data || typeof event.data !== 'object') return undefined;

  const data = event.data as Record<string, unknown>;
  const type = typeof data.type === 'string' ? data.type : '';
  if (type === 'notice') return { ...base, title: 'Pi notice', message: singleLine(String(data.message ?? 'Notice')), level: notificationLevelFromUnknown(data.level), kind: 'notice' };
  if (type === 'auto_retry_start') return { ...base, title: 'Retrying request', message: singleLine(String(data.errorMessage ?? 'Provider error')), level: 'warning', kind: 'retry' };
  if (type === 'auto_retry_end') return { ...base, title: data.success ? 'Retry succeeded' : 'Retry failed', message: singleLine(String(data.success ? 'Request recovered.' : data.finalError ?? 'Provider error')), level: data.success ? 'success' : 'error', kind: 'retry' };
  if (type === 'compaction_end') return { ...base, title: 'Compaction finished', message: data.aborted ? 'Context compaction was aborted.' : 'Context compaction completed.', level: data.aborted ? 'warning' : 'success', kind: 'compaction' };
  if (/approval|permission|confirm/i.test(type)) return { ...base, title: 'Approval needed', message: singleLine(String(data.message ?? type.replace(/_/g, ' '))), level: 'warning', kind: 'notice' };
  if (/input/i.test(type)) return { ...base, title: 'Input needed', message: singleLine(String(data.message ?? type.replace(/_/g, ' '))), level: 'warning', kind: 'notice' };
  if (/review/i.test(type)) return { ...base, title: 'Review ready', message: singleLine(String(data.message ?? type.replace(/_/g, ' '))), level: 'info', kind: 'review' };
  if (/notify|notice/i.test(type)) return { ...base, title: 'Pi notice', message: singleLine(String(data.message ?? type.replace(/_/g, ' '))), level: notificationLevelFromUnknown(data.level), kind: 'notice' };
  return undefined;
}

function notificationLevelFromUnknown(value: unknown): WorkspaceNotificationLevel {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'error' || text === 'danger' || text === 'destructive') return 'error';
  if (text === 'warning' || text === 'warn') return 'warning';
  if (text === 'success' || text === 'done') return 'success';
  return 'info';
}

function isWorkspaceNotificationLevel(value: unknown): value is WorkspaceNotificationLevel {
  return value === 'info' || value === 'success' || value === 'warning' || value === 'error';
}

function isWorkspaceNotificationKind(value: unknown): value is WorkspaceNotificationKind {
  return value === 'agent' || value === 'command' || value === 'notice' || value === 'retry' || value === 'compaction' || value === 'review';
}

function readBrowserNotificationsEnabled() {
  return localStorage.getItem(WORKSPACE_NOTIFICATIONS_BROWSER_KEY) === 'true';
}

function readNotificationSoundEnabled() {
  return localStorage.getItem(WORKSPACE_NOTIFICATIONS_SOUND_KEY) !== 'false';
}

function readNotificationSoundId(): NotificationSoundId {
  const stored = localStorage.getItem(WORKSPACE_NOTIFICATIONS_SOUND_CHOICE_KEY);
  return isNotificationSoundId(stored) ? stored : 'glass';
}

function readNotificationSoundVolume() {
  const stored = localStorage.getItem(WORKSPACE_NOTIFICATIONS_SOUND_VOLUME_KEY);
  if (stored === null) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  const value = Number(stored);
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  return clampNotificationSoundVolume(value > 1 && value <= 100 ? value / 100 : value);
}

function clampNotificationSoundVolume(value: number) {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function notificationSoundVolumePercent(value: number) {
  return Math.round(clampNotificationSoundVolume(value) * 100);
}

function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return value === 'chime' || value === 'ping' || value === 'pop' || value === 'bell' || value === 'ding' || value === 'boop' || value === 'pluck' || value === 'glass' || value === 'success' || value === 'warning' || value === 'alert' || value === 'silent';
}

let workspaceNotificationAudioContext: AudioContext | undefined;

async function unlockWorkspaceNotificationSound() {
  const context = workspaceNotificationAudioContext ?? createWorkspaceNotificationAudioContext();
  if (!context) return;
  workspaceNotificationAudioContext = context;
  if (context.state === 'suspended') await context.resume().catch(() => undefined);
}

function playNotificationSound(level: WorkspaceNotificationLevel, sound: NotificationSoundId, volume: number) {
  const context = workspaceNotificationAudioContext ?? createWorkspaceNotificationAudioContext();
  if (!context) return;
  workspaceNotificationAudioContext = context;
  const play = () => playNotificationTone(context, level, sound, volume);
  if (context.state === 'running') {
    play();
    return;
  }
  void context.resume().then(() => {
    if (context.state === 'running') play();
  }).catch(() => undefined);
}

function createWorkspaceNotificationAudioContext() {
  const AudioContextConstructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return undefined;
  try {
    return new AudioContextConstructor();
  } catch {
    return undefined;
  }
}

function playNotificationTone(context: AudioContext, level: WorkspaceNotificationLevel, sound: NotificationSoundId, volume: number) {
  if (sound === 'silent') return;
  const normalizedVolume = clampNotificationSoundVolume(volume);
  if (!normalizedVolume) return;
  const peak = (level === 'error' ? 0.17 : 0.13) * normalizedVolume;
  const config = (() => {
    if (sound === 'bell') return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [392, 294] : level === 'warning' ? [523, 392] : [784, 659], spacing: 0.14, duration: 0.32, peak: peak * 0.8 };
    if (sound === 'ding') return { type: 'triangle' as OscillatorType, frequencies: level === 'error' ? [330, 220] : level === 'warning' ? [587, 494] : [988], spacing: 0.09, duration: 0.22, peak: peak * 0.9 };
    if (sound === 'ping') return { type: 'triangle' as OscillatorType, frequencies: level === 'error' ? [260, 220] : level === 'warning' ? [520, 440] : [880], spacing: 0.095, duration: 0.16, peak };
    if (sound === 'pop') return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [180, 140] : level === 'warning' ? [320, 420] : [420, 720], spacing: 0.055, duration: 0.12, peak: peak * 0.9 };
    if (sound === 'boop') return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [147, 123] : level === 'warning' ? [247, 196] : [294, 392], spacing: 0.11, duration: 0.2, peak: peak * 0.85 };
    if (sound === 'pluck') return { type: 'triangle' as OscillatorType, frequencies: level === 'error' ? [196, 165, 147] : level === 'warning' ? [440, 330] : [523, 784], spacing: 0.06, duration: 0.1, peak: peak * 0.75 };
    if (sound === 'glass') return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [523, 392, 330] : level === 'warning' ? [740, 587] : [1047, 1319], spacing: 0.09, duration: 0.28, peak: peak * 0.62 };
    if (sound === 'success') return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [262, 220] : level === 'warning' ? [392, 523] : [523, 659, 784], spacing: 0.085, duration: 0.18, peak: peak * 0.9 };
    if (sound === 'warning') return { type: 'triangle' as OscillatorType, frequencies: level === 'error' ? [220, 185, 220] : level === 'warning' ? [440, 370, 440] : [440, 370], spacing: 0.12, duration: 0.18, peak: peak * 0.85 };
    if (sound === 'alert') return { type: 'square' as OscillatorType, frequencies: level === 'error' ? [220, 196, 165] : level === 'warning' ? [392, 330, 392] : [660, 660], spacing: 0.115, duration: 0.18, peak: peak * 0.75 };
    return { type: 'sine' as OscillatorType, frequencies: level === 'error' ? [220, 196, 165] : level === 'warning' ? [392, 330] : [660, 880], spacing: 0.105, duration: 0.2, peak };
  })();
  const start = context.currentTime + 0.01;
  config.frequencies.forEach((frequency, index) => {
    const time = start + index * config.spacing;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(config.peak, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + config.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(time);
    oscillator.stop(time + config.duration + 0.02);
  });
}

function workspaceDisplayName(workspace: ProjectWorkspace, rootProject: Project) {
  return workspace.local ? `${rootProject.name} · local` : workspace.name;
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function agentStatusParts(status?: AgentStatusInfo): AgentStatusPart[] {
  if (!status) return [];
  const parts: AgentStatusPart[] = [];
  if (status.branch) parts.push({ text: `branch ${status.branch}`, title: 'Git branch' });
  if (status.sessionName) parts.push({ text: `session ${status.sessionName}`, title: 'Session name' });

  const usage = [
    status.usage.input ? `↑${formatCompactNumber(status.usage.input)}` : '',
    status.usage.output ? `↓${formatCompactNumber(status.usage.output)}` : '',
    status.usage.cacheRead ? `R${formatCompactNumber(status.usage.cacheRead)}` : '',
    status.usage.cacheWrite ? `W${formatCompactNumber(status.usage.cacheWrite)}` : '',
  ].filter(Boolean);
  if (usage.length) parts.push({ text: usage.join(' '), title: 'Cumulative token usage' });
  if (status.usage.cost || status.usage.subscription) parts.push({ text: `$${status.usage.cost.toFixed(3)}${status.usage.subscription ? ' (sub)' : ''}`, title: 'Estimated cost' });
  if (status.context) {
    const percent = status.context.percent === null ? '?' : `${status.context.percent.toFixed(1)}%`;
    parts.push({
      text: `ctx ${percent}/${formatCompactNumber(status.context.contextWindow)}${status.context.autoCompact ? ' (auto)' : ''}`,
      title: status.context.tokens === null ? 'Context usage unknown until next response' : `${status.context.tokens.toLocaleString()} context tokens`,
      tone: status.context.percent !== null && status.context.percent > 90 ? 'danger' : status.context.percent !== null && status.context.percent > 70 ? 'warning' : undefined,
    });
  }
  for (const item of status.statuses) parts.push({ text: item.text, title: item.key });
  return parts;
}

function formatCompactNumber(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function entryContentParts(entry: SessionEntry, options: { hideThinking: boolean; toolOutputMode: ChatToolOutputMode }): ChatContentPart[] {
  if (entry.type === 'message') {
    const role = entry.message?.role;
    if (role === 'toolResult') return options.toolOutputMode === 'hidden' ? [] : [{ type: 'tool', text: contentText(entry.message?.content).trim() || '(no output)' }];
    const parts = role === 'user' ? stripAttachmentTrailerFromParts(contentParts(entry.message?.content, options)) : contentParts(entry.message?.content, options);
    if (role === 'assistant') {
      const stopReason = typeof entry.message?.stopReason === 'string' ? entry.message.stopReason : undefined;
      const errorMessage = typeof entry.message?.errorMessage === 'string' ? entry.message.errorMessage : undefined;
      if (stopReason === 'aborted') parts.push({ type: 'error', text: errorMessage && errorMessage !== 'Request was aborted' ? errorMessage : 'Operation aborted' });
      else if (stopReason === 'error') parts.push({ type: 'error', text: `Error: ${errorMessage || 'Unknown error'}` });
    }
    return parts;
  }
  if (entry.type === 'custom_message') return contentParts(entry.content, options);
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return [{ type: 'text', text: contentText(entry.summary) }];
  return [{ type: 'text', text: entryText(entry) }];
}

function userMessageAttachments(entry: SessionEntry): UploadAsset[] {
  if (!isUserMessageEntry(entry)) return [];
  return splitAttachmentTrailer(userMessageTextContent(entry.message?.content)).attachments;
}

function userMessageTextContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') return text;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return contentText(content);
}

function stripAttachmentTrailerFromParts(parts: ChatContentPart[]): ChatContentPart[] {
  let index = -1;
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    if (parts[partIndex].type === 'text') {
      index = partIndex;
      break;
    }
  }
  if (index === -1) return parts;
  const split = splitAttachmentTrailer(parts[index].text);
  if (!split.attachments.length) return parts;
  return parts.map((part, partIndex) => partIndex === index ? { ...part, text: split.text } : part).filter((part) => part.text.trim());
}

function splitAttachmentTrailer(text: string): { text: string; attachments: UploadAsset[] } {
  const match = /(?:\r?\n){2,}Attached files in the workspace:\r?\n((?:- [^\r\n]+(?:\r?\n|$))+)[\t ]*$/.exec(text);
  if (!match) return { text, attachments: [] };
  const attachments = match[1].split(/\r?\n/).flatMap((line): UploadAsset[] => {
    const filePath = line.startsWith('- ') ? line.slice(2).trim() : '';
    return filePath ? [{ path: filePath }] : [];
  });
  if (!attachments.length) return { text, attachments: [] };
  return { text: text.slice(0, match.index).trimEnd(), attachments: uniqueUploadAssets(attachments) };
}

function contentParts(content: unknown, options: { hideThinking: boolean; toolOutputMode: ChatToolOutputMode }): ChatContentPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return content ? [{ type: 'text', text: contentText(content) }] : [];
  return content.flatMap((part): ChatContentPart[] => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') return [{ type: 'text', text: record.text }];
    if (typeof record.thinking === 'string') return options.hideThinking ? [] : [{ type: 'thinking', text: record.thinking }];
    if (record.type === 'image') return [{ type: 'image', text: '[image]' }];
    if (record.type === 'toolCall') return options.toolOutputMode === 'expanded' ? [{ type: 'tool', text: `Using tool: ${record.name ?? 'tool'}` }] : [];
    if (typeof record.name === 'string') return options.toolOutputMode === 'expanded' ? [{ type: 'tool', text: `[tool: ${record.name}]` }] : [];
    return [{ type: 'text', text: JSON.stringify(part) }];
  }).filter((part) => part.text.trim());
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.thinking === 'string') return '';
      if (typeof record.name === 'string') return `[tool: ${record.name}]`;
      if (typeof record.type === 'string') return `[${record.type}]`;
    }
    return JSON.stringify(part);
  }).filter(Boolean).join(' ');
  if (!content) return '';
  return JSON.stringify(content).slice(0, 500);
}

function isEditableUserEntry(entry: SessionEntry) {
  return (entry.type === 'message' && entry.message?.role === 'user') || entry.type === 'custom_message';
}

function treeSummaryOptions(selection: TreeSelection) {
  if (selection.contextAction === 'none') return { mode: 'none' };
  if (selection.contextAction === 'summary') return { mode: 'summary' };
  return { mode: 'custom', instructions: selection.customInstructions, replace: selection.replaceInstructions };
}

function branchForEntry(entries: SessionEntry[], leafId: string | null | undefined) {
  if (leafId === undefined) return entries;
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let entry = byId.get(leafId);
  while (entry) {
    branch.unshift(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch;
}

function sessionTreeViewFromDetail(detail: SessionDetail): SessionTreeView {
  const containsActive = treeActivePathMap(detail.tree, detail.leafId);
  return { ...detail, tree: orderTreeNodesByActivePath(detail.tree, containsActive).map((node) => treeViewNodeFromSessionNode(node, containsActive)) };
}

function treeViewNodeFromSessionNode(node: SessionTreeNode, containsActive: Map<SessionTreeNode, boolean>): TreeViewNode {
  const display = treeEntryDisplay(node.entry);
  return {
    ...node,
    id: node.entry.id,
    children: orderTreeNodesByActivePath(node.children, containsActive).map((child) => treeViewNodeFromSessionNode(child, containsActive)),
    display,
    roleClass: entryRoleClass(node.entry),
    searchText: [node.label, entryRole(node.entry), entryText(node.entry), display].filter(Boolean).join(' ').toLowerCase(),
    isSettingsEntry: ['label', 'custom', 'model_change', 'thinking_level_change', 'session_info'].includes(node.entry.type),
    isEmptyAssistant: node.entry.type === 'message'
      && node.entry.message?.role === 'assistant'
      && !hasTextContent(node.entry.message.content)
      && node.entry.message.stopReason !== 'aborted'
      && !node.entry.message.errorMessage,
  };
}

function flattenSessionTree(roots: TreeViewNode[], collapsedIds: Set<string>): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  const multipleRoots = roots.length > 1;
  const stack: Array<[TreeViewNode, number, boolean, boolean, boolean, Array<{ position: number; show: boolean }>, boolean]> = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push([roots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === roots.length - 1, [], multipleRoots]);
  }

  while (stack.length) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
    result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

    if (collapsedIds.has(node.entry.id)) continue;

    const children = node.children;
    const multipleChildren = children.length > 1;
    const childIndent = multipleChildren || (justBranched && indent > 0) ? indent + 1 : indent;
    const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const childGutters = showConnector && !isVirtualRootChild ? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }] : gutters;

    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push([children[i], childIndent, multipleChildren, multipleChildren, i === children.length - 1, childGutters, false]);
    }
  }
  return result;
}

function treeActivePathMap(roots: SessionTreeNode[], leafId: string | null) {
  const containsActive = new Map<SessionTreeNode, boolean>();
  const allNodes: SessionTreeNode[] = [];
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    allNodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  for (let i = allNodes.length - 1; i >= 0; i -= 1) {
    const node = allNodes[i];
    containsActive.set(node, Boolean(leafId && (node.entry.id === leafId || node.children.some((child) => containsActive.get(child)))));
  }
  return containsActive;
}

function orderTreeNodesByActivePath(nodes: SessionTreeNode[], containsActive: Map<SessionTreeNode, boolean>) {
  return [...nodes].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
}

function filterTreeNodes(nodes: FlatTreeNode[], search: string, filterMode: TreeFilterMode, leafId: string | null) {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return nodes.filter((flatNode) => {
    const entry = flatNode.node.entry;
    const isCurrentLeaf = entry.id === leafId;
    if (flatNode.node.isEmptyAssistant && !isCurrentLeaf) return false;

    const passesFilter = filterMode === 'all'
      || (filterMode === 'default' && !flatNode.node.isSettingsEntry)
      || (filterMode === 'no-tools' && !flatNode.node.isSettingsEntry && !(entry.type === 'message' && entry.message?.role === 'toolResult'))
      || (filterMode === 'user-only' && entry.type === 'message' && entry.message?.role === 'user')
      || (filterMode === 'labeled-only' && flatNode.node.label !== undefined);
    if (!passesFilter) return false;
    return !tokens.length || tokens.every((token) => flatNode.node.searchText.includes(token));
  });
}

function treeDisplayIndent(flatNode: FlatTreeNode, multipleRoots: boolean) {
  return multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
}

function treeSelectionForEntry(entry: SessionEntry, contextAction: TreeContextAction): TreeSelection {
  return {
    entry,
    branchFromId: isEditableUserEntry(entry) ? entry.parentId : entry.id,
    text: isEditableUserEntry(entry) ? entryText(entry) : '',
    contextAction,
    customInstructions: '',
    replaceInstructions: false,
  };
}

function TreeEntryIcon(props: { entry: SessionEntry }) {
  const Icon = treeEntryIcon(props.entry);
  return <Icon class="size-3.5" />;
}

function treeEntryIcon(entry: SessionEntry): LucideIcon {
  if (entry.type === 'message' && entry.message?.role === 'user') return User;
  if (entry.type === 'message' && entry.message?.role === 'assistant') return Bot;
  if (entry.type === 'message' && entry.message?.role === 'toolResult') return Wrench;
  if (entry.type === 'message' && entry.message?.role === 'bashExecution') return SquareTerminal;
  if (entry.type === 'compaction') return Archive;
  if (entry.type === 'branch_summary') return AlignJustify;
  if (entry.type === 'custom_message') return MessageSquare;
  if (entry.type === 'label') return Tag;
  if (entry.type === 'model_change') return SlidersHorizontal;
  if (entry.type === 'thinking_level_change') return Brain;
  if (entry.type === 'session_info') return BadgeInfo;
  return FileText;
}

function treeEntryDisplay(entry: SessionEntry) {
  const text = entryText(entry).replace(/[\n\t]/g, ' ').trim();
  if (entry.type === 'message') return `${entry.message?.role ?? 'message'}: ${text || fallbackEntryText(entry)}`;
  if (entry.type === 'custom_message') return `[${entry.customType}]: ${text}`;
  if (entry.type === 'compaction') return `[compaction: ${Math.round(Number(entry.tokensBefore ?? 0) / 1000)}k tokens]`;
  if (entry.type === 'branch_summary') return `[branch summary]: ${text}`;
  if (entry.type === 'session_info') return `[title: ${entry.name || 'empty'}]`;
  return `[${entryRole(entry)}${text ? `: ${text}` : ''}]`;
}

function fallbackEntryText(entry: SessionEntry) {
  if (entry.type === 'message' && entry.message?.role === 'assistant') {
    if (entry.message.stopReason === 'aborted') return '(aborted)';
    if (entry.message.errorMessage) return String(entry.message.errorMessage);
    return '(no content)';
  }
  return entry.id;
}

function entryRoleClass(entry: SessionEntry) {
  if (entry.type === 'message' && entry.message?.role === 'user') return 'text-foreground';
  if (entry.type === 'message' && entry.message?.role === 'assistant') return 'text-success';
  return 'text-muted-foreground';
}

function hasTextContent(content: unknown) {
  return contentText(content).trim().length > 0;
}

function richTextParts(text: string): RichTextPart[] {
  const result: RichTextPart[] = [];
  const codePattern = /`([^`\n]+)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(text))) {
    if (match.index > cursor) result.push(...plainRichTextParts(text.slice(cursor, match.index)));
    result.push({ text: match[1], kind: 'code' });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push(...plainRichTextParts(text.slice(cursor)));
  return result.length ? result : [{ text }];
}

function plainRichTextParts(text: string): RichTextPart[] {
  const result: RichTextPart[] = [];
  const textPattern = /\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(text))) {
    if (match.index > cursor) appendFileMentionParts(result, text.slice(cursor, match.index));
    result.push({ text: match[1], kind: 'strong' });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) appendFileMentionParts(result, text.slice(cursor));
  return result;
}

function composerHighlightParts(text: string): RichTextPart[] {
  const result: RichTextPart[] = [];
  appendFileMentionParts(result, text);
  return result.length ? result : [{ text }];
}

function appendFileMentionParts(result: RichTextPart[], text: string) {
  const mentionPattern = /(^|[\s([{])(@(?:"(?:\\.|[^"\n])*(?:"|$)|[A-Za-z0-9._~/-]*))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text))) {
    const leading = match[1] ?? '';
    const mention = match[2] ?? '';
    const mentionStart = match.index + leading.length;
    if (mentionStart > cursor) result.push({ text: text.slice(cursor, mentionStart) });
    result.push({ text: mention, kind: 'file' });
    cursor = mentionStart + mention.length;
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) });
}

function assetUrl(projectId: string, filePath: string) {
  return appUrl(`/api/projects/${projectId}/asset?path=${encodeURIComponent(filePath)}`);
}

function isImagePath(filePath: string) {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(filePath);
}

function isVideoPath(filePath: string) {
  return /\.(mp4|webm|mov|m4v)$/i.test(filePath);
}

function isPdfPath(filePath: string) {
  return /\.pdf$/i.test(filePath);
}

function isTextPath(filePath: string) {
  return /\.(txt|md|mdx|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yaml|yml|toml|ini|env|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sql|log)$/i.test(filePath);
}

function activeFileMention(value: string, cursor: number): FileMention | undefined {
  const beforeCursor = value.slice(0, cursor);
  const quotedMatch = beforeCursor.match(/(^|[\s([{])@"((?:\\.|[^"\n])*)$/);
  if (quotedMatch) return { query: unescapeComposerFileReferenceQuery(quotedMatch[2]), start: cursor - quotedMatch[2].length - 2, end: cursor, quoted: true };
  const match = beforeCursor.match(/(^|[\s([{])@([A-Za-z0-9._~/-]*)$/);
  if (!match) return undefined;
  return { query: match[2], start: cursor - match[2].length - 1, end: cursor };
}

function formatComposerFileReference(filePath: string, forceQuoted = false) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (!forceQuoted && /^[A-Za-z0-9._~/-]+$/.test(normalizedPath)) return `@${normalizedPath}`;
  return `@"${normalizedPath.replace(/["\\]/g, (character) => `\\${character}`)}"`;
}

function unescapeComposerFileReferenceQuery(value: string) {
  return value.replace(/\\(["\\])/g, '$1');
}

function activeSlashCommand(value: string, cursor: number): SlashCommandMention | undefined {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return undefined;
  return { query: match[1], start: 0, end: cursor };
}

function composerSlashCommandName(prompt: string) {
  const match = prompt.trim().match(/^\/([^\s/]+)/);
  return match?.[1];
}

function activeCommandArgument(value: string, cursor: number): CommandArgumentMention | undefined {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]+)\s+([^\n]*)$/);
  if (!match) return undefined;
  const argsPrefix = match[2];
  return {
    commandName: match[1],
    query: argsPrefix,
    start: cursor - argsPrefix.length,
    end: cursor,
  };
}

function filterSlashCommands(commands: SlashCommand[], query: string) {
  const normalized = query.toLowerCase();
  const filtered = normalized
    ? commands.filter((command) => command.name.toLowerCase().includes(normalized) || command.description?.toLowerCase().includes(normalized) || command.argumentHint?.toLowerCase().includes(normalized))
    : commands;
  return filtered.slice(0, 12);
}

function commandSourceLabel(command: SlashCommand) {
  return [command.source, command.location].filter(Boolean).join(' · ');
}

function parseShellComposerCommand(prompt: string) {
  if (!prompt.startsWith('!')) return undefined;
  const excludeFromContext = prompt.startsWith('!!');
  const command = prompt.slice(excludeFromContext ? 2 : 1).trim();
  return command ? { command, excludeFromContext } : undefined;
}

function parseCompactComposerCommand(prompt: string) {
  const match = prompt.match(/^\/compact(?:\s+([\s\S]*))?$/);
  return match ? match[1]?.trim() || '' : undefined;
}

function textareaActivePosition(target: HTMLTextAreaElement) {
  return target.selectionDirection === 'backward' ? target.selectionStart : target.selectionEnd;
}

function setTextareaCursor(target: HTMLTextAreaElement, position: number, extendSelection = false) {
  if (!extendSelection) {
    target.setSelectionRange(position, position);
    return;
  }
  const anchor = target.selectionDirection === 'backward' ? target.selectionEnd : target.selectionStart;
  target.setSelectionRange(Math.min(anchor, position), Math.max(anchor, position), position < anchor ? 'backward' : 'forward');
}

function textareaLineStart(value: string, position: number) {
  if (position <= 0) return 0;
  return value.lastIndexOf('\n', position - 1) + 1;
}

function textareaLineEnd(value: string, position: number) {
  const index = value.indexOf('\n', position);
  return index === -1 ? value.length : index;
}

function textareaPreviousWordStart(value: string, position: number) {
  let cursor = position;
  while (cursor > 0 && /\s/.test(value[cursor - 1])) cursor -= 1;
  while (cursor > 0 && !/\s/.test(value[cursor - 1])) cursor -= 1;
  return cursor;
}

function textareaNextWordEnd(value: string, position: number) {
  let cursor = position;
  while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
  while (cursor < value.length && !/\s/.test(value[cursor])) cursor += 1;
  return cursor;
}

function sessionModelReference(detail: SessionDetail) {
  for (const entry of [...detail.branch].reverse()) {
    if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') return `${entry.provider}/${entry.modelId}`;
    const message = entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message : undefined;
    if (message && typeof message.provider === 'string' && typeof message.model === 'string') return `${message.provider}/${message.model}`;
  }
  return undefined;
}

function sessionThinkingLevel(detail: SessionDetail): ThinkingLevel | undefined {
  for (const entry of [...detail.branch].reverse()) {
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string' && isThinkingLevel(entry.thinkingLevel)) return entry.thinkingLevel;
  }
  return undefined;
}

function composerModelOptions(settings?: PiSettings, models: ModelListItem[] = [], selectedReference?: string): SelectOption[] {
  const defaultReference = defaultModelReference(settings);
  const labels = new Map(models.map((model) => [model.value, model.label]));
  const configuredReferences = new Set(uniqueStrings([defaultReference, ...(settings?.enabledModels ?? []).map(modelReferenceFromPattern)]));
  const references = uniqueStrings([
    defaultReference,
    ...models.map((model) => model.value),
    ...(settings?.enabledModels ?? []).map(modelReferenceFromPattern),
    selectedReference,
  ]);
  return [
    { value: '', label: modelReferenceLabel(defaultReference) },
    ...references.filter((reference) => reference !== defaultReference).map((reference) => ({
      value: reference,
      label: labels.get(reference) ?? (reference === selectedReference && !configuredReferences.has(reference) ? `Extra: ${modelReferenceLabel(reference)}` : modelReferenceLabel(reference)),
    })),
  ];
}

function settingsDefaultModelOptions(scope: 'global' | 'project', inheritedReference: string | undefined, models: ModelListItem[], selectedReference: string): SelectOption[] {
  const labels = new Map(models.map((model) => [model.value, model.label]));
  const references = uniqueStrings([...models.map((model) => model.value), selectedReference]);
  return [
    { value: '', label: scope === 'project' ? `Inherited${inheritedReference ? `: ${modelReferenceLabel(inheritedReference)}` : ''}` : 'Pi default' },
    ...references.map((reference) => ({
      value: reference,
      label: labels.get(reference) ?? (reference === selectedReference ? `Current: ${modelReferenceLabel(reference)}` : modelReferenceLabel(reference)),
    })),
  ];
}

function settingsThinkingLevelOptions(scope: 'global' | 'project', inheritedLevel: ThinkingLevel | undefined, levels?: ThinkingLevel[], selectedLevel?: ThinkingLevel): SelectOption[] {
  const inherited = inheritedLevel ?? 'medium';
  const effective = clampThinkingLevel(inherited, levels);
  const currentOption = selectedLevel && levels && !levels.includes(selectedLevel)
    ? [{ value: selectedLevel, label: `Current: ${thinkingLevelLabel(selectedLevel)} (unsupported by selected model)` }]
    : [];
  return [
    { value: '', label: scope === 'project' ? `Inherited: ${thinkingLevelLabel(effective)}${effective !== inherited ? ` (from ${thinkingLevelLabel(inherited)})` : ''}` : `Pi default: ${thinkingLevelLabel(effective)}` },
    ...currentOption,
    ...thinkingLevelValueOptionsForLevels(levels),
  ];
}

function composerThinkingLevelOptions(settings: PiSettings | undefined, models: ModelListItem[], selectedModel: string): SelectOption[] {
  const levels = modelThinkingLevels(models, selectedModel || defaultModelReference(settings));
  const defaultLevel = clampThinkingLevel(settings?.defaultThinkingLevel ?? 'medium', levels);
  return [
    { value: '', label: thinkingLevelLabel(defaultLevel) },
    ...thinkingLevelValueOptionsForLevels(levels),
  ];
}

function thinkingLevelValueOptionsForLevels(levels?: ThinkingLevel[]) {
  return THINKING_LEVEL_VALUE_OPTIONS.filter((option) => !levels || levels.includes(option.value as ThinkingLevel));
}

function modelThinkingLevels(models: ModelListItem[], reference?: string): ThinkingLevel[] | undefined {
  if (!reference) return undefined;
  const levels = models.find((model) => model.value === reference)?.thinkingLevels;
  return levels?.filter(isThinkingLevel);
}

function clampThinkingLevel(level: ThinkingLevel, levels?: ThinkingLevel[]): ThinkingLevel {
  if (!levels || levels.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return levels[0] ?? 'off';
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (levels.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? 'off';
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === 'off') return 'Off';
  if (level === 'minimal') return 'Minimal';
  if (level === 'low') return 'Low';
  if (level === 'medium') return 'Medium';
  if (level === 'high') return 'High';
  return 'Xhigh';
}

function parseModelReference(reference: string) {
  const slashIndex = reference.indexOf('/');
  if (slashIndex <= 0 || slashIndex === reference.length - 1) return undefined;
  return { provider: reference.slice(0, slashIndex), modelId: reference.slice(slashIndex + 1) };
}

function defaultModelReference(settings?: PiSettings) {
  if (settings?.defaultProvider && settings.defaultModel) return `${settings.defaultProvider}/${settings.defaultModel}`;
  return settings?.defaultModel;
}

function modelReferenceFromPattern(pattern: string) {
  let reference = pattern.trim();
  if (!reference || /[*?\[]/.test(reference)) return undefined;
  const colonIndex = reference.lastIndexOf(':');
  if (colonIndex !== -1 && isThinkingLevel(reference.slice(colonIndex + 1))) reference = reference.slice(0, colonIndex);
  return reference;
}

function modelReferenceLabel(reference?: string) {
  if (!reference) return 'Model';
  const slashIndex = reference.indexOf('/');
  const modelId = slashIndex === -1 ? reference : reference.slice(slashIndex + 1);
  if (/^gpt-/i.test(modelId)) return modelId.replace(/^gpt/i, 'GPT');
  if (/^claude-/i.test(modelId)) return `Claude ${modelId.slice('claude-'.length).replace(/-/g, ' ')}`;
  if (/^gemini-/i.test(modelId)) return `Gemini ${modelId.slice('gemini-'.length).replace(/-/g, ' ')}`;
  return modelId;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value);
}

function chatToolOutputMode(settings?: PiSettings): ChatToolOutputMode {
  return settings?.chatToolOutput ?? 'compact';
}

function pruneSettings(settings: PiSettings): PiSettings {
  return pruneSettingValue(settings) as PiSettings;
}

function pruneSettingValue(value: unknown): unknown {
  if (value === undefined || value === '') return null;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pruneSettingValue(item)]));
}

function uniqueStrings(items: Array<string | undefined>) {
  return [...new Set(items.filter((item): item is string => Boolean(item)))];
}

function uniqueUploadAssets(items: UploadAsset[]) {
  const byPath = new Map<string, UploadAsset>();
  for (const item of items) byPath.set(item.path, { ...byPath.get(item.path), ...item });
  return [...byPath.values()];
}

function composerUploadAssets(items: UploadAsset[]) {
  return uniqueUploadAssets(cloneUploadAssets(items).flatMap((asset): UploadAsset[] => {
    const path = asset.path.trim();
    return isWorkspaceUploadPath(path) ? [{ ...asset, path }] : [];
  }));
}

function isWorkspaceUploadPath(filePath: string) {
  return filePath.replace(/\\/g, '/').startsWith('.pi-web/uploads/');
}

async function resolveComposerFileReferenceAssets(projectId: string, value: string): Promise<UploadAsset[]> {
  const paths = uniqueStrings(composerFileReferencePaths(value)).slice(0, 50);
  const assets = await Promise.all(paths.map(async (filePath): Promise<UploadAsset | undefined> => {
    const result = await api<{ files: ProjectFileSearchEntry[] }>(`/api/projects/${projectId}/files/search?query=${encodeURIComponent(filePath)}`).catch(() => undefined);
    const file = result?.files.find((item) => item.path === filePath);
    return file ? { path: file.path, filename: file.name } : undefined;
  }));
  return uniqueUploadAssets(assets.filter((asset): asset is UploadAsset => Boolean(asset)));
}

function composerFileReferencePaths(value: string) {
  const paths: string[] = [];
  const mentionPattern = /(^|[\s([{])@(?:"((?:\\.|[^"\n])*)(?:"|$)|([A-Za-z0-9._~/-]+))/g;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(value))) {
    const filePath = (match[2]
      ? unescapeComposerFileReferenceQuery(match[2])
      : (match[3] ?? '').replace(/[.,!?;:)}\]"']+$/, '')
    ).trim();
    if (filePath) paths.push(filePath);
  }
  return paths;
}

function composerDraftKey(projectId: string, sessionId?: string) {
  return `${projectId}\0${sessionId ?? ''}`;
}

function readComposerDraft(key: string): ComposerDraft {
  const draft = composerDrafts.get(key);
  return draft ? { text: draft.text, uploads: composerUploadAssets(draft.uploads), commandSessionId: draft.commandSessionId, treeSelection: draft.treeSelection, model: draft.model, thinking: draft.thinking } : { text: '', uploads: [] };
}

function saveComposerDraft(key: string, draft: ComposerDraft) {
  const uploads = composerUploadAssets(draft.uploads);
  if (!draft.text && !uploads.length && !draft.treeSelection && !draft.model && !draft.thinking) {
    composerDrafts.delete(key);
    return;
  }
  composerDrafts.set(key, { text: draft.text, uploads, commandSessionId: draft.commandSessionId, treeSelection: draft.treeSelection, model: draft.model, thinking: draft.thinking });
}

function uploadAssetLabel(asset: UploadAsset) {
  const pathName = asset.path.split('/').filter(Boolean).at(-1);
  return asset.filename?.trim() || pathName || asset.path;
}

function joinRelativePath(base: string, name: string) {
  return base ? `${base}/${name}` : name;
}

function fileSearchEntryFromPath(filePath: string): ProjectFileSearchEntry {
  return { path: filePath, name: filePath.split('/').filter(Boolean).at(-1) ?? filePath, directory: parentPath(filePath) };
}

function readRecentFiles(projectId: string): ProjectFileSearchEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${RECENT_FILES_KEY_PREFIX}${projectId}`) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((file): file is ProjectFileSearchEntry => Boolean(file) && typeof file.path === 'string' && typeof file.name === 'string' && typeof file.directory === 'string')
      .slice(0, 20);
  } catch {
    return [];
  }
}

function rememberRecentFile(projectId: string, file: ProjectFileSearchEntry) {
  const files = [file, ...readRecentFiles(projectId).filter((item) => item.path !== file.path)].slice(0, 20);
  localStorage.setItem(`${RECENT_FILES_KEY_PREFIX}${projectId}`, JSON.stringify(files));
}

function invalidateProjectFileListQueries(projectId: string) {
  queryClient.invalidateQueries({ queryKey: ['files', projectId] });
  queryClient.invalidateQueries({ queryKey: ['file-search', projectId] });
}

function invalidateProjectFileQueries(projectId: string) {
  invalidateProjectFileListQueries(projectId);
  queryClient.invalidateQueries({ queryKey: ['file-preview', projectId] });
}

function invalidateProjectFileCaches(projectId: string) {
  void api<{ ok: true }>(`/api/projects/${projectId}/files/invalidate`, { method: 'POST' })
    .catch(() => undefined)
    .finally(() => invalidateProjectFileQueries(projectId));
}

function fileSearchTokens(query: string) {
  return query.trim().toLowerCase().split(/[\s/.]+/).filter(Boolean);
}

function highlightFileSearchText(text: string, query: string): JSX.Element[] {
  const tokens = fileSearchTokens(query);
  if (!tokens.length) return [text];
  const parts: JSX.Element[] = [];
  const lowerText = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    let matchIndex = -1;
    let matchToken = '';
    for (const token of tokens) {
      const index = lowerText.indexOf(token, cursor);
      if (index !== -1 && (matchIndex === -1 || index < matchIndex || (index === matchIndex && token.length > matchToken.length))) {
        matchIndex = index;
        matchToken = token;
      }
    }
    if (matchIndex === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex));
    parts.push(<span class="file-search-match">{text.slice(matchIndex, matchIndex + matchToken.length)}</span>);
    cursor = matchIndex + matchToken.length;
  }
  return parts;
}

function absoluteProjectPath(projectPath: string, relativePath: string) {
  if (!relativePath) return projectPath;
  return `${projectPath.replace(/[\\/]+$/, '')}/${relativePath}`;
}

function parentPath(value: string) {
  return value.split('/').slice(0, -1).join('/');
}

function ProjectAvatarContent(props: { project: Project; preference?: ProjectPreference; imageSrc?: string }) {
  const imageSrc = createMemo(() => props.imageSrc ?? (props.preference?.image ? assetUrl(props.project.id, props.preference.image) : undefined));
  return (
    <Show when={imageSrc()} fallback={<span>{projectAvatarLetter(props.project.name)}</span>}>
      {(src) => <img class="project-avatar-image" src={src()} alt="" />}
    </Show>
  );
}

function projectPreference(project: Project): ProjectPreference {
  return {
    color: isProjectColorId(project.color) ? project.color : undefined,
    image: project.image?.trim() || undefined,
  };
}

function projectColorStyle(project: Project, preference?: ProjectPreference) {
  return projectColorStyleFromColor(projectColorForProject(project, preference));
}

function projectColorStyleFromColor(color: ProjectColor) {
  return {
    '--project-accent': color.value,
    '--project-accent-foreground': color.foreground,
  } as JSX.CSSProperties;
}

function projectColorForProject(project: Project, preference?: ProjectPreference) {
  return (preference?.color ? PROJECT_COLORS.find((color) => color.id === preference.color) : undefined)
    ?? PROJECT_COLORS.find((color) => color.id === defaultProjectColorId(project))
    ?? PROJECT_COLORS[0];
}

function defaultProjectColorId(project: Project): ProjectColorId {
  return PROJECT_COLORS[hashString(project.path || project.id || project.name) % PROJECT_COLORS.length].id;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function projectAvatarLetter(name: string) {
  return (name.replace(/^(pi|project|workspace)[-_\s]+/i, '').match(/[a-z0-9]/i)?.[0] ?? name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
}

function projectNameFromPath(projectPath: string) {
  const trimmed = projectPath.trim().replace(/[\\/]+$/g, '');
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || trimmed || 'Workspace';
}

function projectWorkspaceFromProject(project: Project): ProjectWorkspace {
  return { id: project.id, rootProjectId: project.id, name: project.name, path: project.path, local: true, removable: false };
}

function isProjectColorId(value: unknown): value is ProjectColorId {
  return typeof value === 'string' && PROJECT_COLOR_IDS.has(value as ProjectColorId);
}

type FileIconDefinition = { Icon: LucideIcon; className: string };

function FileTypeIcon(props: { name: string; class?: string }) {
  const icon = fileIconForName(props.name);
  const Icon = icon.Icon;
  return <Icon class={`${props.class ?? 'size-4'} file-icon ${icon.className}`} />;
}

function DirectoryTypeIcon(props: { name: string; class?: string }) {
  const icon = directoryIconForName(props.name);
  const Icon = icon.Icon;
  return <Icon class={`${props.class ?? 'size-4'} file-icon ${icon.className}`} />;
}

function fileIconForName(name: string): FileIconDefinition {
  const lower = name.toLowerCase();
  const baseName = lower.split(/[\\/]/).at(-1) ?? lower;
  if (/^(package(?:-lock)?|pnpm-lock|yarn\.lock|bun\.lockb|composer|cargo|gemfile|go\.mod|go\.sum|requirements)\b/.test(baseName)) return { Icon: Package, className: 'text-orange-500 dark:text-orange-400' };
  if (/^(tsconfig|jsconfig|vite|vitest|webpack|rollup|esbuild|tailwind|postcss|eslint|prettier|biome|babel|next|nuxt|astro|svelte|solid|jest|playwright|cypress|commitlint|lint-staged)[\w.-]*\./.test(baseName)) return { Icon: FileCog, className: 'text-slate-500 dark:text-slate-400' };
  if (/^\.env($|\.)/.test(baseName)) return { Icon: FileLock, className: 'text-yellow-600 dark:text-yellow-400' };
  if (/^(\.npmrc|\.yarnrc|\.pnp|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|dockerfile|docker-compose|compose\.)/.test(baseName)) return { Icon: FileCog, className: 'text-yellow-600 dark:text-yellow-400' };
  if (/^(license|copying|security)(\.|$)/.test(baseName)) return { Icon: FileCheck, className: 'text-emerald-600 dark:text-emerald-400' };
  if (/^(readme|changelog|contributing)(\.|$)/.test(baseName)) return { Icon: FileText, className: 'text-blue-500 dark:text-blue-400' };
  if (/^(makefile|justfile|procfile|\.bashrc|\.zshrc|\.profile)$/.test(baseName)) return { Icon: FileTerminal, className: 'text-green-600 dark:text-green-400' };
  if (isImagePath(lower)) return { Icon: FileImage, className: 'text-emerald-500 dark:text-emerald-400' };
  if (isVideoPath(lower)) return { Icon: FileVideo, className: 'text-purple-500 dark:text-purple-400' };
  if (isArchivePath(lower)) return { Icon: FileArchive, className: 'text-orange-500 dark:text-orange-400' };
  if (/\.(tsx|jsx)$/i.test(lower)) return { Icon: CodeXml, className: 'text-sky-500 dark:text-sky-400' };
  if (/\.(ts|mts|cts)$/i.test(lower)) return { Icon: FileCode2, className: 'text-blue-500 dark:text-blue-400' };
  if (/\.(js|mjs|cjs)$/i.test(lower)) return { Icon: FileCode2, className: 'text-yellow-500 dark:text-yellow-400' };
  if (/\.(json|jsonc)$/i.test(lower)) return { Icon: FileJson, className: 'text-amber-500 dark:text-amber-400' };
  if (/\.(md|mdx)$/i.test(lower)) return { Icon: FileText, className: 'text-blue-500 dark:text-blue-300' };
  if (/\.(css|scss|sass|less)$/i.test(lower)) return { Icon: Palette, className: 'text-pink-500 dark:text-pink-400' };
  if (/\.(html|xml|vue|svelte)$/i.test(lower)) return { Icon: CodeXml, className: 'text-orange-500 dark:text-orange-400' };
  if (/\.(yaml|yml|toml|ini)$/i.test(lower)) return { Icon: FileCog, className: 'text-violet-500 dark:text-violet-400' };
  if (/\.(env|pem|key|crt|cert|lock)$/i.test(lower)) return { Icon: FileLock, className: 'text-yellow-600 dark:text-yellow-400' };
  if (/\.(sh|bash|zsh|fish|ps1)$/i.test(lower)) return { Icon: FileTerminal, className: 'text-green-600 dark:text-green-400' };
  if (/\.(db|sqlite|sqlite3|sql)$/i.test(lower)) return { Icon: Database, className: 'text-indigo-500 dark:text-indigo-400' };
  if (/\.(py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php)$/i.test(lower)) return { Icon: FileCode2, className: 'text-cyan-600 dark:text-cyan-400' };
  if (/\.(graphql|gql)$/i.test(lower)) return { Icon: Braces, className: 'text-pink-500 dark:text-pink-400' };
  if (/\.(txt|pdf|log)$/i.test(lower)) return { Icon: FileText, className: 'text-muted-foreground' };
  if (/\.(woff2?|ttf|otf|eot)$/i.test(lower)) return { Icon: FileType, className: 'text-rose-500 dark:text-rose-400' };
  return { Icon: FileIcon, className: 'text-muted-foreground' };
}

function directoryIconForName(name: string): FileIconDefinition {
  const lower = name.toLowerCase();
  if (lower === '.git') return { Icon: FolderGit, className: 'text-orange-500 dark:text-orange-400' };
  if (lower === 'node_modules' || lower === 'vendor' || lower === 'packages') return { Icon: Package, className: 'text-green-600 dark:text-green-400' };
  if (/^(src|source|app|pages|routes|components|lib|utils|hooks|server|client)$/.test(lower)) return { Icon: FolderOpen, className: 'text-sky-500 dark:text-sky-400' };
  if (/^(public|static|assets|images|img|icons|media)$/.test(lower)) return { Icon: FolderOpen, className: 'text-emerald-500 dark:text-emerald-400' };
  if (/^(test|tests|__tests__|spec|specs|e2e|coverage)$/.test(lower)) return { Icon: FolderOpen, className: 'text-rose-500 dark:text-rose-400' };
  if (/^(dist|build|out|target|bin|release|releases)$/.test(lower)) return { Icon: Archive, className: 'text-amber-500 dark:text-amber-400' };
  if (/^(\.github|\.gitlab|\.vscode|\.idea|\.config|config|configs|scripts|tools)$/.test(lower)) return { Icon: FileCog, className: 'text-violet-500 dark:text-violet-400' };
  return { Icon: FolderOpen, className: 'text-blue-500 dark:text-blue-400' };
}

function isArchivePath(filePath: string) {
  return /\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(filePath);
}

async function restoreOpenProjects(projectPaths: string[], currentPaths: string[], activePath: string | undefined, setProjectId: (id?: string) => void) {
  const restored: Project[] = [];
  for (const projectPath of projectPaths) {
    try {
      const { project } = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      restored.push(project);
    } catch {
      // Drop projects that no longer exist or are not reachable from this server.
    }
  }
  writeProjectPaths(OPEN_PROJECTS_KEY, [...currentPaths, ...restored.map((project) => project.path)]);
  if (!restored.length) return;
  await queryClient.invalidateQueries({ queryKey: ['projects'] });
  const activeProject = restored.find((project) => project.path === activePath);
  if (activeProject) setProjectId(activeProject.id);
}

function readSessionComposerControls(projectId: string, sessionId: string): SessionComposerControls | undefined {
  const controls = readSessionComposerControlsMap()[sessionComposerControlsKey(projectId, sessionId)];
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) return undefined;
  const model = typeof controls.model === 'string' ? controls.model : undefined;
  const thinking = typeof controls.thinking === 'string' && (controls.thinking === '' || isThinkingLevel(controls.thinking)) ? controls.thinking : undefined;
  return { ...('model' in controls ? { model: model ?? '' } : {}), ...('thinking' in controls ? { thinking: thinking ?? '' } : {}) };
}

function writeSessionComposerControls(projectId: string, sessionId: string, controls: SessionComposerControls) {
  const map = readSessionComposerControlsMap();
  map[sessionComposerControlsKey(projectId, sessionId)] = controls;
  localStorage.setItem(SESSION_COMPOSER_CONTROLS_KEY, JSON.stringify(map));
}

function readSessionComposerControlsMap(): Record<string, SessionComposerControls> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_COMPOSER_CONTROLS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, SessionComposerControls> : {};
  } catch {
    return {};
  }
}

function sessionComposerControlsKey(projectId: string, sessionId: string) {
  return `${projectId}:${sessionId}`;
}

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_MODE_KEY);
  if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  return 'system';
}

function readBrowserTabName() {
  return (localStorage.getItem(BROWSER_TAB_NAME_KEY) ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
}

function readContrastUserMessages() {
  return localStorage.getItem(CONTRAST_USER_MESSAGES_KEY) !== 'false';
}

function readSystemThemeMode(): ResolvedThemeMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function normalizedShortcutKey(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (key === ' ') return 'space';
  if (key === '+') return 'plus';
  return key;
}

function shortcutTargetElement(event: KeyboardEvent) {
  return event.target instanceof Element ? event.target : undefined;
}

function isShortcutTypingTarget(target: Element | undefined) {
  if (!target) return false;
  const editable = target.closest('input, textarea, select, [contenteditable="true"]');
  return Boolean(editable && !(editable instanceof HTMLInputElement && editable.type === 'hidden'));
}

function hasBlockingShortcutDialog() {
  return Boolean(document.querySelector(SHORTCUT_BLOCKING_DIALOG_SELECTOR));
}

function isMacPlatform() {
  return /mac|iphone|ipad|ipod/.test(navigator.platform.toLowerCase());
}

function isTerminalShortcutAllowed(id: string, steps: string[]) {
  if (steps.length === 1) return isTerminalSingleStepShortcut(id, steps[0]);
  return steps.length > 1 && isTerminalShortcutChordPrefix(steps[0]);
}

function isTerminalSingleStepShortcut(id: string, step: string) {
  const allowedSteps = TERMINAL_SINGLE_STEP_SHORTCUT_BINDINGS[id];
  return Boolean(allowedSteps && [...allowedSteps].some((allowedStep) => equivalentBindingStep(allowedStep, step)));
}

function isTerminalShortcutChordPrefix(step: string) {
  return [...TERMINAL_SHORTCUT_CHORD_PREFIXES].some((prefix) => equivalentBindingStep(prefix, step));
}

function equivalentBindingStep(left: string, right: string) {
  const leftParts = bindingStepParts(left);
  const rightParts = bindingStepParts(right);
  if (!leftParts || !rightParts || leftParts.key !== rightParts.key) return false;
  return leftParts.ctrl === rightParts.ctrl
    && leftParts.meta === rightParts.meta
    && leftParts.shift === rightParts.shift
    && leftParts.alt === rightParts.alt;
}

function bindingStepParts(step: string) {
  const parts = step.split('+');
  const key = parts.pop();
  if (!key) return undefined;
  const mac = isMacPlatform();
  return {
    key,
    ctrl: parts.includes('ctrl') || (parts.includes('mod') && !mac),
    meta: parts.includes('meta') || (parts.includes('mod') && mac),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

function workspaceShortcutEventKey(event: KeyboardEvent) {
  if (/^Digit[1-9]$/.test(event.code)) return event.code.slice(5);
  const key = normalizedShortcutKey(event);
  return WORKSPACE_SHORTCUT_KEYS.includes(key) ? key : undefined;
}

function workspaceShortcutLabel(index: number) {
  return WORKSPACE_SHORTCUT_KEYS[index]?.toUpperCase();
}

function readKeybindingOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function writeKeybindingOverrides(overrides: Record<string, string>) {
  if (Object.keys(overrides).length) localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(overrides));
  else localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
  setShortcutBindingsVersion((version) => version + 1);
}

function getShortcutBinding(id: string): string {
  shortcutBindingsVersion();
  const overrides = readKeybindingOverrides();
  return overrides[id] ?? DEFAULT_SHORTCUT_BINDINGS[id] ?? '';
}

function bindingSteps(binding: string) {
  return binding.trim().split(/\s+/).filter(Boolean);
}

function formatBindingStep(step: string): string {
  const mac = isMacPlatform();
  return step
    .split('+')
    .map((p) => {
      if (p === 'mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'ctrl') return mac ? '⌃' : 'Ctrl';
      if (p === 'meta') return '⌘';
      if (p === 'alt') return mac ? '⌥' : 'Alt';
      if (p === 'shift') return mac ? '⇧' : 'Shift';
      if (p === 'space') return 'Space';
      if (p === 'plus') return '+';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(mac ? '' : '+');
}

function formatBinding(binding: string): string {
  if (!binding) return '—';
  return bindingSteps(binding).map(formatBindingStep).join(' then ');
}

function eventToBinding(event: KeyboardEvent): string | 'cancel' | undefined {
  const key = normalizedShortcutKey(event);
  if (key === 'escape') return 'cancel';
  if (key === 'backspace') return '';
  if (['shift', 'control', 'meta', 'alt', 'altgraph'].includes(key)) return undefined;
  const parts: string[] = [];
  const mac = isMacPlatform();
  if (mac) {
    if (event.metaKey) parts.push('mod');
    if (event.ctrlKey) parts.push('ctrl');
  } else {
    if (event.ctrlKey) parts.push('mod');
    if (event.metaKey) parts.push('meta');
  }
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

function isModifierShortcutKey(key: string) {
  return ['shift', 'control', 'meta', 'alt', 'altgraph'].includes(key);
}

function matchBindingStep(step: string, event: KeyboardEvent): boolean {
  const parts = step.split('+');
  const expectedKey = parts.pop()!;
  const eventKey = normalizedShortcutKey(event);
  if (eventKey !== expectedKey) return false;

  const hasMod = parts.includes('mod');
  const hasCtrl = parts.includes('ctrl');
  const hasMeta = parts.includes('meta');
  const hasShift = parts.includes('shift');
  const hasAlt = parts.includes('alt');
  const mac = isMacPlatform();

  const expectedCtrl = hasCtrl || (hasMod && !mac);
  const expectedMeta = hasMeta || (hasMod && mac);
  if (expectedCtrl !== event.ctrlKey || expectedMeta !== event.metaKey) return false;
  if (hasShift !== event.shiftKey) return false;
  if (hasAlt !== event.altKey) return false;
  return true;
}

function matchBinding(id: string, event: KeyboardEvent): boolean {
  const steps = bindingSteps(getShortcutBinding(id));
  return steps.length === 1 && matchBindingStep(steps[0], event);
}

function readRecentProjects() {
  return readProjectPaths(RECENT_PROJECTS_KEY);
}

function readWorkspacesEnabledByPath(): Record<string, boolean> {
  const stored = localStorage.getItem(WORKSPACES_ENABLED_KEY);
  if (!stored) return {};
  if (stored === 'true') {
    const activePath = readActiveProjectPath();
    return activePath ? { [activePath]: true } : {};
  }
  if (stored === 'false') return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === 'string' && entry[1] === true));
  } catch {
    return {};
  }
}

function writeWorkspacesEnabledByPath(value: Record<string, boolean>) {
  localStorage.setItem(WORKSPACES_ENABLED_KEY, JSON.stringify(value));
}

function readLastWorkspaceSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_WORKSPACE_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function writeLastWorkspaceSessions(value: Record<string, string>) {
  const entries = Object.entries(value).filter((entry): entry is [string, string] => Boolean(entry[0]) && Boolean(entry[1]));
  if (entries.length) localStorage.setItem(LAST_WORKSPACE_SESSIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  else localStorage.removeItem(LAST_WORKSPACE_SESSIONS_KEY);
}

function readOpenProjects() {
  const activePath = readActiveProjectPath();
  const paths = readProjectPaths(OPEN_PROJECTS_KEY);
  const migratedPaths = localStorage.getItem(OPEN_PROJECTS_KEY) === null ? readRecentProjects() : [];
  return uniqueProjectPaths(activePath ? [activePath, ...paths, ...migratedPaths] : [...paths, ...migratedPaths]);
}

function rememberRecentProject(projectPath: string) {
  writeProjectPaths(RECENT_PROJECTS_KEY, [projectPath, ...readRecentProjects()].slice(0, 20));
}

function rememberOpenProject(projectPath: string) {
  writeProjectPaths(OPEN_PROJECTS_KEY, [projectPath, ...readOpenProjects()]);
}

function forgetOpenProject(projectPath: string) {
  writeProjectPaths(OPEN_PROJECTS_KEY, readOpenProjects().filter((path) => path !== projectPath));
}

function readProjectPaths(key: string) {
  try {
    const value = localStorage.getItem(key);
    const paths = value ? JSON.parse(value) : [];
    return Array.isArray(paths) ? paths.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeProjectPaths(key: string, paths: string[]) {
  localStorage.setItem(key, JSON.stringify(uniqueProjectPaths(paths)));
}

function uniqueProjectPaths(paths: string[]) {
  return [...new Set(paths.filter((path) => path.trim()))];
}

function readProjectOrder(): string[] {
  try {
    const stored = localStorage.getItem(PROJECT_ORDER_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeProjectOrder(projectIds: string[]) {
  localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(projectIds));
}

function orderProjects(projects: Project[], order: string[]): Project[] {
  const orderMap = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => {
    const aIndex = orderMap.get(a.id);
    const bIndex = orderMap.get(b.id);
    if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
    if (aIndex !== undefined) return -1;
    if (bIndex !== undefined) return 1;
    return 0;
  });
}

function readActiveProjectPath() {
  const encodedPath = new URLSearchParams(location.search).get(PROJECT_QUERY_KEY);
  return (encodedPath ? decodeProjectPath(encodedPath) : undefined) ?? localStorage.getItem(ACTIVE_PROJECT_KEY) ?? undefined;
}

function writeActiveProjectPath(projectPath?: string) {
  const url = new URL(location.href);
  if (projectPath) {
    localStorage.setItem(ACTIVE_PROJECT_KEY, projectPath);
    url.searchParams.set(PROJECT_QUERY_KEY, encodeProjectPath(projectPath));
  } else {
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    url.searchParams.delete(PROJECT_QUERY_KEY);
  }
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function readActiveWorkspacePath() {
  const encodedPath = new URLSearchParams(location.search).get(WORKSPACE_QUERY_KEY);
  return encodedPath ? decodeProjectPath(encodedPath) : undefined;
}

function writeActiveWorkspacePath(projectPath?: string, workspacePath?: string) {
  const url = new URL(location.href);
  if (projectPath && workspacePath && workspacePath !== projectPath) url.searchParams.set(WORKSPACE_QUERY_KEY, encodeProjectPath(workspacePath));
  else url.searchParams.delete(WORKSPACE_QUERY_KEY);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function readActiveSessionId() {
  return new URLSearchParams(location.search).get(SESSION_QUERY_KEY) || undefined;
}

function writeActiveSessionId(sessionId?: string) {
  const url = new URL(location.href);
  if (sessionId) url.searchParams.set(SESSION_QUERY_KEY, sessionId);
  else url.searchParams.delete(SESSION_QUERY_KEY);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function encodeProjectPath(projectPath: string) {
  const bytes = new TextEncoder().encode(projectPath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeProjectPath(value: string) {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const projectPath = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    return looksLikeProjectPath(projectPath) ? projectPath : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeProjectPath(projectPath: string) {
  return projectPath.startsWith('/') || projectPath.startsWith('~') || /^[A-Za-z]:[\\/]/.test(projectPath);
}

function mergeRecentProjects(projects: Project[], recentPaths: string[]): ProjectFolder[] {
  const folders = new Map<string, ProjectFolder>();
  for (const project of projects) folders.set(project.path, { path: project.path, displayPath: displayProjectPath(project.path), name: project.name });
  for (const projectPath of recentPaths) folders.set(projectPath, { path: projectPath, displayPath: displayProjectPath(projectPath), name: projectPath.split('/').filter(Boolean).at(-1) ?? projectPath });
  return [...folders.values()];
}

function filterProjectFolders(folders: ProjectFolder[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return folders;
  return folders.filter((folder) => folder.name.toLowerCase().includes(query) || folder.path.toLowerCase().includes(query) || folder.displayPath.toLowerCase().includes(query));
}

function splitDisplayPath(value: string) {
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const index = trimmed.lastIndexOf('/');
  if (index === -1) return { prefix: '', name: value };
  return { prefix: `${trimmed.slice(0, index + 1)}`, name: `${trimmed.slice(index + 1)}/` };
}

function displayProjectPath(projectPath: string) {
  return projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function apiErrorStatus(error: unknown) {
  return error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : undefined;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(appUrl(url), init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    const error = new Error(typeof body.error === 'string' ? body.error : response.statusText) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json();
}

render(() => <App />, document.getElementById('root')!);
