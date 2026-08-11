import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTerminalTab, createTerminalWorkspaceState, removeTerminalTab, requestTerminalTabClose, subscribeTerminalWorkspaceState, updateTerminalTabExited, updateTerminalTabSessionNonce, updateTerminalTabTitle, updateTerminalWorkspaceState } from './terminalTabs';

test('new terminals receive stable labels and become active', () => {
  const initial = createTerminalWorkspaceState();
  const second = addTerminalTab(initial, 'terminal-two');
  const third = addTerminalTab(second, 'terminal-three');

  assert.deepEqual(third.tabs.map(({ id, number }) => ({ id, number })), [
    { id: 'main', number: 1 },
    { id: 'terminal-two', number: 2 },
    { id: 'terminal-three', number: 3 },
  ]);
  assert.equal(third.activeId, 'terminal-three');
  assert.equal(third.nextNumber, 4);
});

test('a pending terminal close persists until disposal completes', () => {
  const state = addTerminalTab(createTerminalWorkspaceState(), 'terminal-two');
  const closing = requestTerminalTabClose(state, 'terminal-two');

  assert.equal(closing.tabs[1]?.closing, true);
  assert.equal(closing.activeId, 'terminal-two');
  assert.equal(requestTerminalTabClose(closing, 'terminal-two'), closing);
});

test('terminal exit state can be recorded and cleared after restart', () => {
  const state = updateTerminalTabExited(createTerminalWorkspaceState(), 'main', true);

  assert.equal(state.tabs[0]?.exited, true);
  assert.equal(updateTerminalTabExited(state, 'main', false).tabs[0]?.exited, undefined);
});

test('closing the active terminal selects the adjacent terminal', () => {
  const state = addTerminalTab(addTerminalTab(createTerminalWorkspaceState(), 'terminal-two'), 'terminal-three');

  const afterMiddleClose = removeTerminalTab({ ...state, activeId: 'terminal-two' }, 'terminal-two');
  assert.equal(afterMiddleClose.activeId, 'terminal-three');

  const afterFinalClose = removeTerminalTab(afterMiddleClose, 'terminal-three');
  assert.equal(afterFinalClose.activeId, 'main');

  const empty = removeTerminalTab(afterFinalClose, 'main');
  assert.equal(empty.activeId, undefined);
  assert.deepEqual(empty.tabs, []);
});

test('closing a background terminal preserves the active terminal', () => {
  const state = addTerminalTab(addTerminalTab(createTerminalWorkspaceState(), 'terminal-two'), 'terminal-three');
  assert.equal(removeTerminalTab(state, 'terminal-two').activeId, 'terminal-three');
});

test('late disposal removes from the latest shared workspace without overwriting remounted state', () => {
  const persisted = createTerminalWorkspaceState();
  let remounted = { ...persisted, tabs: [...persisted.tabs] };
  const unsubscribe = subscribeTerminalWorkspaceState(persisted, (state) => {
    remounted = { ...state, tabs: [...state.tabs] };
  });

  updateTerminalWorkspaceState(persisted, (current) => addTerminalTab(current, 'terminal-two'));
  updateTerminalWorkspaceState(persisted, (current) => removeTerminalTab(current, 'main'));

  assert.deepEqual(persisted.tabs.map(({ id }) => id), ['terminal-two']);
  assert.deepEqual(remounted.tabs.map(({ id }) => id), ['terminal-two']);
  assert.equal(remounted.activeId, 'terminal-two');
  unsubscribe();
});

test('late disposal cannot remove a replacement created after the original ID was retired', () => {
  const persisted = createTerminalWorkspaceState();

  updateTerminalWorkspaceState(persisted, (current) => removeTerminalTab(current, 'main'));
  updateTerminalWorkspaceState(persisted, () => createTerminalWorkspaceState('terminal-replacement'));
  updateTerminalWorkspaceState(persisted, (current) => removeTerminalTab(current, 'main'));

  assert.deepEqual(persisted.tabs.map(({ id }) => id), ['terminal-replacement']);
  assert.equal(persisted.activeId, 'terminal-replacement');
});

test('terminal session nonces follow the tab incarnation', () => {
  const state = updateTerminalTabSessionNonce(createTerminalWorkspaceState(), 'main', 'nonce-one');

  assert.equal(state.tabs[0]?.sessionNonce, 'nonce-one');
  assert.equal(updateTerminalTabSessionNonce(state, 'main', 'nonce-one'), state);
});

test('terminal titles update without changing identity or numbering', () => {
  const state = addTerminalTab(createTerminalWorkspaceState(), 'terminal-two');
  const updated = updateTerminalTabTitle(state, 'terminal-two', 'zsh');

  assert.deepEqual(updated.tabs[1], { id: 'terminal-two', number: 2, title: 'zsh' });
  assert.equal(updateTerminalTabTitle(updated, 'missing', 'bash'), updated);
});
