import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalGeneratedReply, terminalQueriesExpectingReplies, terminalReplyMatchesQuery } from './terminalReplay';

test('recognizes terminal-generated replies that historical queries can reproduce', () => {
  for (const reply of [
    '\x1b[?1;2c',
    '\x1b[>0;276;0c',
    '\x1b[0n',
    '\x1b[12;40R',
    '\x1b[?12;40R',
    '\x1b[?2026;1$y',
    '\x1b[8;24;80t',
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    '\x1b]4;7;rgb:aaaa/bbbb/cccc\x1b\\',
    '\x1bP1$r0m\x1b\\',
  ]) assert.equal(isTerminalGeneratedReply(reply), true, JSON.stringify(reply));
});

test('matches generated replies only to their carried query', () => {
  assert.equal(terminalReplyMatchesQuery('\x1b[6n', '\x1b[12;40R'), true);
  assert.equal(terminalReplyMatchesQuery('\x1b[5n', '\x1b[0n'), true);
  assert.equal(terminalReplyMatchesQuery('\x1b[>c', '\x1b[>0;276;0c'), true);
  assert.equal(terminalReplyMatchesQuery('\x1b[?2026$p', '\x1b[?2026;1$y'), true);
  assert.equal(terminalReplyMatchesQuery('\x1b]11;?\x07', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), true);
  assert.equal(terminalReplyMatchesQuery('\x1bP$qm\x1b\\', '\x1bP1$r0m\x1b\\'), true);
  assert.equal(terminalReplyMatchesQuery('\x1b[6n', '\x1b[>0;276;0c'), false);
});

test('expands stacked OSC color queries into independently matched replies', () => {
  const paletteQueries = terminalQueriesExpectingReplies('\x1b]4;1;?;2;?\x07');
  assert.deepEqual(paletteQueries, ['\x1b]4;1;?\x07', '\x1b]4;2;?\x07']);
  assert.equal(terminalReplyMatchesQuery(paletteQueries[0] ?? '', '\x1b]4;1;rgb:aaaa/bbbb/cccc\x1b\\'), true);
  assert.equal(terminalReplyMatchesQuery(paletteQueries[1] ?? '', '\x1b]4;2;rgb:dddd/eeee/ffff\x1b\\'), true);

  assert.deepEqual(terminalQueriesExpectingReplies('\x1b]10;?;?;?\x1b\\'), [
    '\x1b]10;?\x07',
    '\x1b]11;?\x07',
    '\x1b]12;?\x07',
  ]);
});

test('does not classify normal keyboard, paste, or focus input as terminal replies', () => {
  for (const input of [
    'text',
    '\x1b[A',
    '\x1b[3~',
    '\x1bc',
    '\x1b[I',
    '\x1b[O',
    '\x1b[200~pasted text\x1b[201~',
  ]) assert.equal(isTerminalGeneratedReply(input), false, JSON.stringify(input));
});
