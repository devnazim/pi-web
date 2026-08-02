export function isTerminalGeneratedReply(data: string) {
  if (data.charCodeAt(0) !== 0x1b) return false;

  if (/^\x1b\[(?:[?>]?[0-9;]*c|\??[0-9;]*[nR]|\??[0-9;]+\$y|(?:4|6|8);[0-9;]+t)$/.test(data)) return true;
  if (/^\x1b\](?:4;[0-9]+|10|11|12);rgb:[0-9a-f/]+\x1b\\$/i.test(data)) return true;
  return /^\x1bP[01]\$r[\s\S]*\x1b\\$/.test(data);
}

export function terminalQueriesExpectingReplies(query: string) {
  if (!query.startsWith('\x1b]') && !query.startsWith('\x9d')) return [query];
  const introducerLength = query.startsWith('\x1b]') ? 2 : 1;
  const contentEnd = query.endsWith('\x1b\\') ? query.length - 2 : query.length - 1;
  const parts = query.slice(introducerLength, contentEnd).split(';');
  const selectors: string[] = [];

  if (parts[0] === '4') {
    for (let index = 1; index + 1 < parts.length; index += 2) {
      if (/^[0-9]+$/.test(parts[index] ?? '') && parts[index + 1] === '?') selectors.push(`4;${parts[index]}`);
    }
  } else {
    const firstSelector = Number(parts[0]);
    if (Number.isInteger(firstSelector) && firstSelector >= 10 && firstSelector <= 12) {
      for (let index = 1; index < parts.length && firstSelector + index - 1 <= 12; index += 1) {
        if (parts[index] === '?') selectors.push(String(firstSelector + index - 1));
      }
    }
  }

  return selectors.map((selector) => `\x1b]${selector};?\x07`);
}

export function terminalReplyMatchesQuery(query: string, reply: string) {
  if (!isTerminalGeneratedReply(reply)) return false;

  if (query.startsWith('\x1b[') || query.startsWith('\x9b')) {
    const introducerLength = query.startsWith('\x1b[') ? 2 : 1;
    const finalByte = query.at(-1) ?? '';
    const body = query.slice(introducerLength, -1);
    if (finalByte === 'c') return /^\x1b\[[?>]?[0-9;]*c$/.test(reply);
    if (finalByte === 'n') return body.endsWith('5') ? reply === '\x1b[0n' : /^\x1b\[\??[0-9]+;[0-9]+R$/.test(reply);
    if (finalByte === 'p') return /^\x1b\[\??[0-9;]+\$y$/.test(reply);
    return finalByte === 't' && /^\x1b\[(?:4|6|8);[0-9;]+t$/.test(reply);
  }

  if (query.startsWith('\x1b]') || query.startsWith('\x9d')) {
    const introducerLength = query.startsWith('\x1b]') ? 2 : 1;
    const selector = query.slice(introducerLength).split(';?')[0];
    return reply.startsWith(`\x1b]${selector};rgb:`);
  }

  return (query.startsWith('\x1bP') || query.startsWith('\x90')) && /^\x1bP[01]\$r[\s\S]*\x1b\\$/.test(reply);
}
