import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalPanelMinimumHeight } from './terminalLayout';

test('terminal minimum height derives nine rows from rendered desktop geometry', () => {
  assert.equal(terminalPanelMinimumHeight({
    panelHeight: 260,
    hostHeight: 184,
    xtermPaddingTop: 8,
    xtermPaddingBottom: 14,
    screenHeight: 154,
    renderedRows: 7,
  }), 296);
});

test('terminal minimum height includes responsive toolbar geometry', () => {
  assert.equal(terminalPanelMinimumHeight({
    panelHeight: 260,
    hostHeight: 104,
    xtermPaddingTop: 8,
    xtermPaddingBottom: 14,
    screenHeight: 110,
    renderedRows: 5,
  }), 376);
});
