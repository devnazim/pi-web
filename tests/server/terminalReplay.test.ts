import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTerminalReplayData, createTerminalReplaySanitizerState, recordTerminalReplayResize, sanitizeTerminalReplayChunk, trimTerminalReplay, trimTerminalReplayEntries } from '../../src/server/terminalReplay.ts';

test('terminal replay records data under ordered resize boundaries', () => {
  const entries = [{ cols: 80, rows: 24, data: '' }];
  appendTerminalReplayData(entries, 'before\n', 1024, 10);
  recordTerminalReplayResize(entries, 100, 30, 1024, 10);
  appendTerminalReplayData(entries, 'after\n', 1024, 10);

  assert.deepEqual(entries, [
    { cols: 80, rows: 24, data: 'before\n' },
    { cols: 100, rows: 30, data: 'after\n' },
  ]);
});

test('terminal replay coalesces empty resizes and bounds entry count and data', () => {
  const entries = [{ cols: 80, rows: 24, data: '' }];
  recordTerminalReplayResize(entries, 90, 25, 12, 3);
  recordTerminalReplayResize(entries, 100, 30, 12, 3);
  assert.deepEqual(entries, [{ cols: 100, rows: 30, data: '' }]);

  for (let index = 0; index < 5; index += 1) {
    appendTerminalReplayData(entries, `line-${index}\n`, 12, 3);
    recordTerminalReplayResize(entries, 101 + index, 31, 12, 3);
  }
  trimTerminalReplayEntries(entries, 12, 3);

  assert.ok(entries.length <= 3);
  assert.ok(entries.reduce((total, entry) => total + entry.data.length, 0) <= 12);
  assert.deepEqual({ cols: entries.at(-1)?.cols, rows: entries.at(-1)?.rows }, { cols: 105, rows: 31 });
});

test('terminal replay removes device queries and replies without changing display sequences', () => {
  const replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), [
    'prompt ',
    '\x1b[32mok\x1b[0m ',
    '\x1b[>c',
    '\x1b[>0;276;0c',
    '\x1b[6n',
    '\x1b[12;40R',
    'done\n',
  ].join(''));

  assert.equal(replay.data, 'prompt \x1b[32mok\x1b[0m done\n');
  assert.equal(replay.state.mode, 'ground');
});

test('terminal replay carries split CSI and OSC sequences between PTY chunks', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), 'before \x1b]11;');
  assert.equal(replay.data, 'before ');
  assert.equal(replay.state.mode, 'osc');
  assert.equal(replay.state.sequenceParts.join(''), '\x1b]11;');

  replay = sanitizeTerminalReplayChunk(replay.state, '?\x07\x1b[>0;');
  assert.equal(replay.data, '');
  assert.equal(replay.state.mode, 'csi');
  assert.equal(replay.state.sequenceParts.join(''), '\x1b[>0;');
  assert.deepEqual(replay.settled, { consumed: 2, dataLength: 0, livePrefix: '', responseQuery: '\x1b]11;?\x07' });

  replay = sanitizeTerminalReplayChunk(replay.state, '276;0c\x1b[36mafter\x1b[0m\n');
  assert.equal(replay.data, '\x1b[36mafter\x1b[0m\n');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, { consumed: 6, dataLength: 0, livePrefix: '' });
});

test('terminal replay carries a stacked OSC color query across chunks', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b]4;1;?;2;');
  replay = sanitizeTerminalReplayChunk(replay.state, '?\x07text');

  assert.equal(replay.data, 'text');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, {
    consumed: 2,
    dataLength: 0,
    livePrefix: '',
    responseQuery: '\x1b]4;1;?;2;?\x07',
  });
});

test('terminal replay marks the first safe boundary before sanitizing later live queries', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b[>0;');
  replay = sanitizeTerminalReplayChunk(replay.state, '276;0c\x1b[6nLIVE');

  assert.equal(replay.data, 'LIVE');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, { consumed: 6, dataLength: 0, livePrefix: '' });
});

test('terminal replay preserves complete control strings and split escape sequences that do not generate replies', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), 'before \x1b(');
  assert.equal(replay.data, 'before ');
  assert.equal(replay.state.mode, 'escape');
  assert.equal(replay.state.sequenceParts.join(''), '\x1b(');

  replay = sanitizeTerminalReplayChunk(replay.state, 'B\x1bPpayload\x07more\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x07after\n');
  assert.equal(replay.data, '\x1b(B\x1bPpayload\x07more\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x07after\n');
  assert.equal(replay.state.mode, 'ground');
});

test('terminal replay keeps executable controls inside a split ESC sequence', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b(');
  replay = sanitizeTerminalReplayChunk(replay.state, '\n\x7fBafter');

  assert.equal(replay.data, '\n\x1b(Bafter');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, { consumed: 3, dataLength: 4, livePrefix: '' });
});

test('terminal replay preserves executable controls when filtering or cancelling a sequence', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b[6');
  replay = sanitizeTerminalReplayChunk(replay.state, '\nntext');
  assert.equal(replay.data, '\ntext');
  assert.deepEqual(replay.settled, { consumed: 2, dataLength: 1, livePrefix: '', responseQuery: '\x1b[6n' });

  replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b(\n\x18after');
  assert.equal(replay.data, '\nafter');
  assert.equal(replay.state.mode, 'ground');
});

test('terminal replay executes a non-introducer C1 control and settles a pending string', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b]title');
  replay = sanitizeTerminalReplayChunk(replay.state, '\x84VISIBLE');

  assert.equal(replay.data, '\x84VISIBLE');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, { consumed: 1, dataLength: 1, livePrefix: '' });
});

test('terminal replay handles C1 device and color sequences', () => {
  const replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), 'a\x9b>0;276;0cb\x9d10;?\x9cc');
  assert.equal(replay.data, 'abc');
  assert.equal(replay.state.mode, 'ground');
});

test('terminal replay recovers from cancelled and restarted malformed sequences', () => {
  const cancelled = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), 'before\x1b]unterminated\x18after');
  assert.equal(cancelled.data, 'beforeafter');
  assert.equal(cancelled.state.mode, 'ground');

  const restarted = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), 'before\x1b]unterminated\x1b[32mafter\x1b[0m');
  assert.equal(restarted.data, 'before\x1b[32mafter\x1b[0m');
  assert.equal(restarted.state.mode, 'ground');
});

test('terminal replay reconstructs a restarted escape sequence across chunk boundaries', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b]unterminated\x1b');
  replay = sanitizeTerminalReplayChunk(replay.state, '[32mtext\x1b[0m');

  assert.equal(replay.data, '\x1b[32mtext\x1b[0m');
  assert.equal(replay.state.mode, 'ground');
  assert.deepEqual(replay.settled, { consumed: 0, dataLength: 0, livePrefix: '\x1b' });
});

test('terminal replay bounds chunked unterminated control sequence state and resumes after its terminator', () => {
  let replay = sanitizeTerminalReplayChunk(createTerminalReplaySanitizerState(), '\x1b]52;c;');
  for (let index = 0; index < 70 * 1024; index += 1) replay = sanitizeTerminalReplayChunk(replay.state, 'a');
  assert.equal(replay.data, '');
  assert.equal(replay.state.mode, 'osc');
  assert.equal(replay.state.discarding, true);
  assert.equal(replay.state.sequenceParts.length, 0);

  replay = sanitizeTerminalReplayChunk(replay.state, 'discarded\x1b\\after');
  assert.equal(replay.data, 'after');
  assert.equal(replay.state.mode, 'ground');
});

test('terminal replay trimming starts outside control sequences and on a line boundary when possible', () => {
  assert.equal(trimTerminalReplay('first line\nsecond line\nthird line', 24), 'third line');

  const osc = `\x1b]52;c;${'a'.repeat(40)}\x1b\\`;
  assert.equal(trimTerminalReplay(`prefix${osc}tail`, 32), 'tail');
  const c0Csi = `\x1b\n[${'9'.repeat(40)}m`;
  assert.equal(trimTerminalReplay(`prefix${c0Csi}tail`, 32), 'tail');
  const delOsc = `\x1b\x7f]52;c;${'a'.repeat(40)}\x07`;
  assert.equal(trimTerminalReplay(`prefix${delOsc}tail`, 32), 'tail');
  const unicodeReplay = trimTerminalReplay(`prefix${'😀'.repeat(20)}`, 20);
  assert.equal(unicodeReplay.charCodeAt(0) >= 0xdc00 && unicodeReplay.charCodeAt(0) <= 0xdfff, false);
});
