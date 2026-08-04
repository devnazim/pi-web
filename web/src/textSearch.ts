export function parseTextSearchPatternInput(value: string) {
  return splitGlobAware(value.replace(/\\/g, '/'), ',')
    .map((pattern) => pattern.trim().replace(/\/+$/g, ''))
    .filter(Boolean);
}

function splitGlobAware(value: string, separator: string) {
  const parts: string[] = [];
  let current = '';
  let braceDepth = 0;
  let inBrackets = false;
  let bracketCharacters = 0;
  let bracketNegated = false;

  for (const character of value) {
    if (character === separator && braceDepth === 0 && !inBrackets) {
      parts.push(current);
      current = '';
      continue;
    }
    if (inBrackets) {
      if (bracketCharacters === 0 && (character === '!' || character === '^')) {
        bracketNegated = true;
        bracketCharacters += 1;
      } else if (character === ']' && bracketCharacters > (bracketNegated ? 1 : 0)) inBrackets = false;
      else bracketCharacters += 1;
    } else if (character === '[') {
      inBrackets = true;
      bracketCharacters = 0;
      bracketNegated = false;
    } else if (character === '{') braceDepth += 1;
    else if (character === '}' && braceDepth > 0) braceDepth -= 1;
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}
