import assert from 'node:assert/strict';
import test from 'node:test';
import { WebExtensionTerminal } from '../../src/server/webExtensionTerminal.ts';

test('web extension terminal forwards TUI output, input, and resize', async () => {
  const terminal = new WebExtensionTerminal();
  const output: string[] = [];
  const input: string[] = [];
  let resizes = 0;

  terminal.attach((data) => output.push(data));
  terminal.start((data) => input.push(data), () => { resizes += 1; });
  terminal.receiveInput('hello');
  terminal.resize(120, 40);
  terminal.hideCursor();
  terminal.showCursor();
  terminal.clearLine();
  terminal.clearFromCursor();
  terminal.clearScreen();
  terminal.moveBy(2);
  terminal.moveBy(-3);
  terminal.setTitle('safe\x1btitle');
  terminal.setProgress(true);
  terminal.setProgress(false);
  await terminal.drainInput();
  terminal.stop();

  assert.deepEqual(input, ['hello']);
  assert.equal(terminal.columns, 120);
  assert.equal(terminal.rows, 40);
  assert.equal(resizes, 1);
  assert.match(output.join(''), /\x1b\[\?2004h/);
  assert.match(output.join(''), /\x1b\[>4;2m/);
  assert.match(output.join(''), /\x1b\[2B/);
  assert.match(output.join(''), /\x1b\[3A/);
  assert.match(output.join(''), /\x1b\]0;safetitle\x07/);
  assert.match(output.join(''), /\x1b\[\?2004l/);
});

test('web extension terminal clamps dimensions and detaches only its writer', () => {
  const terminal = new WebExtensionTerminal();
  const first: string[] = [];
  const second: string[] = [];
  const firstWriter = (data: string) => first.push(data);
  const secondWriter = (data: string) => second.push(data);

  terminal.start(() => undefined, () => undefined);
  terminal.attach(firstWriter);
  terminal.detach(secondWriter);
  terminal.write('first');
  terminal.resize(1, 1000);
  terminal.attach(secondWriter);
  terminal.write('second');

  assert.equal(terminal.columns, 20);
  assert.equal(terminal.rows, 200);
  assert.equal(first.at(-1), 'first');
  assert.equal(second.at(-1), 'second');
});
