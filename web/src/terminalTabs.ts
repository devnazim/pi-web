export type TerminalTab = { id: string; number: number; title: string; closing?: boolean; exited?: boolean; sessionNonce?: string };

export type TerminalWorkspaceState = {
  tabs: TerminalTab[];
  activeId?: string;
  nextNumber: number;
};

const terminalWorkspaceListeners = new WeakMap<TerminalWorkspaceState, Set<(state: TerminalWorkspaceState) => void>>();

export function updateTerminalWorkspaceState(state: TerminalWorkspaceState, update: (current: TerminalWorkspaceState) => TerminalWorkspaceState) {
  const next = update(state);
  if (next === state) return state;
  Object.assign(state, next);
  for (const listener of terminalWorkspaceListeners.get(state) ?? []) listener(state);
  return state;
}

export function subscribeTerminalWorkspaceState(state: TerminalWorkspaceState, listener: (state: TerminalWorkspaceState) => void) {
  let listeners = terminalWorkspaceListeners.get(state);
  if (!listeners) {
    listeners = new Set();
    terminalWorkspaceListeners.set(state, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) terminalWorkspaceListeners.delete(state);
  };
}

export function createTerminalWorkspaceState(id = 'main'): TerminalWorkspaceState {
  return {
    tabs: [{ id, number: 1, title: 'terminal' }],
    activeId: id,
    nextNumber: 2,
  };
}

export function addTerminalTab(state: TerminalWorkspaceState, id: string): TerminalWorkspaceState {
  if (state.tabs.some((tab) => tab.id === id)) return state;
  return {
    tabs: [...state.tabs, { id, number: state.nextNumber, title: 'terminal' }],
    activeId: id,
    nextNumber: state.nextNumber + 1,
  };
}

export function updateTerminalTabTitle(state: TerminalWorkspaceState, id: string, title: string): TerminalWorkspaceState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || tab.title === title) return state;
  return { ...state, tabs: state.tabs.map((item) => item.id === id ? { ...item, title } : item) };
}

export function updateTerminalTabSessionNonce(state: TerminalWorkspaceState, id: string, sessionNonce: string): TerminalWorkspaceState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || tab.sessionNonce === sessionNonce) return state;
  return { ...state, tabs: state.tabs.map((item) => item.id === id ? { ...item, sessionNonce } : item) };
}

export function requestTerminalTabClose(state: TerminalWorkspaceState, id: string): TerminalWorkspaceState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || tab.closing) return state;
  return { ...state, tabs: state.tabs.map((item) => item.id === id ? { ...item, closing: true } : item) };
}

export function updateTerminalTabExited(state: TerminalWorkspaceState, id: string, exited: boolean): TerminalWorkspaceState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || Boolean(tab.exited) === exited) return state;
  return { ...state, tabs: state.tabs.map((item) => item.id === id ? { ...item, exited: exited || undefined } : item) };
}

export function removeTerminalTab(state: TerminalWorkspaceState, id: string): TerminalWorkspaceState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (closingIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return {
    ...state,
    tabs,
    activeId: state.activeId === id ? tabs[Math.min(closingIndex, tabs.length - 1)]?.id : state.activeId,
  };
}
