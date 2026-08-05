import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompleteMermaidFence, isMermaidCodeFence, mermaidSourceUsesBlockedAssets } from './mermaidRenderer';

test('recognizes Mermaid code fence info case-insensitively', () => {
  assert.equal(isMermaidCodeFence('mermaid'), true);
  assert.equal(isMermaidCodeFence('  Mermaid title=flow  '), true);
  assert.equal(isMermaidCodeFence('typescript'), false);
  assert.equal(isMermaidCodeFence(), false);
});

test('recognizes completed backtick and tilde Mermaid fences', () => {
  assert.equal(isCompleteMermaidFence('```mermaid\ngraph TD\n  A --> B\n```'), true);
  assert.equal(isCompleteMermaidFence('~~~~mermaid\ngraph TD\n  A --> B\n~~~~\n'), true);
  assert.equal(isCompleteMermaidFence('````mermaid\ngraph TD\n  A --> B\n`````'), true);
});

test('rejects incomplete or too-short closing fences while streaming', () => {
  assert.equal(isCompleteMermaidFence('```mermaid\ngraph TD\n  A --> B'), false);
  assert.equal(isCompleteMermaidFence('````mermaid\ngraph TD\n  A --> B\n```'), false);
  assert.equal(isCompleteMermaidFence('```mermaid'), false);
});

test('blocks source configuration, images, and external styles before rendering', () => {
  assert.equal(mermaidSourceUsesBlockedAssets('---\nconfig:\n  c4:\n    person_bg_color: "u/**/rl(/api/mermaid-probe)"\n---\nC4Context\n  Person(user, "User")'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('  ---\n  config:\n    c4:\n      person_bg_color: "u\\/**\\/rl(/api/mermaid-probe)"\n  ---\n  C4Context\n    Person(user, "User")'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('%%{init: {"theme": "forest"}}%%\nflowchart LR\n  A --> B'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A@{ img: "https://example.com/pixel.png" }'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A@{ "\\u0069mg": "/api/mermaid-probe" }'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A@{ "\\x69mg": "/api/mermaid-probe" }'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('sequenceDiagram\n  participant A@{ "icon": "/api/image" }'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('eventmodeling\n  tf 01 evt Start {<video src="https://attacker.example/probe.mp4"></video>}'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('eventmodeling\n  tf 01 evt Start {<table title=">" background="/api/mermaid-probe"><tr><td>x</td></tr></table>}'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('eventmodeling\n  tf 01 evt Start {<span style="background:u&#114l(/api/mermaid-probe)">x</span>}'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef remote fill:u&#x72l(/api/mermaid-probe)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A[![probe](/api/mermaid-probe)]'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef remote fill:url(https://example.com/fill.svg)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef remote fill:u/**/rl(/api/mermaid-probe)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef remote fill:u\\/**\\/rl(/api/mermaid-probe)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef remote fill:u\\72l(\\2f api/mermaid-probe)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A\n  classDef remote mask-image:image-set("/api/mermaid-probe" 1x)'), true);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A[Visit https://example.com] --> B'), false);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A[First line<br/>Second line] --> B'), false);
  assert.equal(mermaidSourceUsesBlockedAssets('flowchart LR\n  A --> B\n  classDef local fill:u/**/rl(#gradient)'), false);
});
