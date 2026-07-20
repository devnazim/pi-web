import type { SessionEntry as PiSessionEntry } from '@earendil-works/pi-coding-agent';

export type AppMode = 'chat' | 'tree' | 'review';
export type ServerLogMode = 'quiet' | 'verbose' | 'debug' | 'silent';

export interface ServerOptions {
  host: string;
  port: number;
  dev: boolean;
  logMode?: ServerLogMode;
  password?: string;
  workspace?: string;
  expose: boolean;
  basePath: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  image?: string;
  hidden?: boolean;
}

export interface ProjectWorkspace {
  id: string;
  rootProjectId: string;
  name: string;
  path: string;
  branch?: string;
  local: boolean;
  removable: boolean;
}

export interface SessionSummary {
  id: string;
  sessionUuid?: string;
  projectId: string;
  title: string;
  path: string;
  updatedAt: string;
  entryCount: number;
}

export type SessionEntry = PiSessionEntry;

export interface SessionDetail {
  sessionId: string;
  path: string;
  header: { id?: string; timestamp?: string; cwd?: string; type?: string; version?: number } | null;
  entries: SessionEntry[];
  leafId: string | null;
  name?: string;
}

export interface GitFileChange {
  path: string;
  oldPath?: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  stagedAdditions?: number;
  stagedDeletions?: number;
  unstagedAdditions?: number;
  unstagedDeletions?: number;
}

export interface GitStatus {
  branch: string;
  files: GitFileChange[];
}

export interface AgentEvent {
  type: string;
  operationId?: string;
  sessionId?: string;
  entry?: SessionEntry;
  message?: string;
  data?: unknown;
}
