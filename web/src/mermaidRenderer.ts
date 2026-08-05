import type { MermaidConfig } from 'mermaid';

export type MermaidThemeMode = 'light' | 'dark';

export const MERMAID_SOURCE_MAX_LENGTH = 50_000;

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderId = 0;

export function isMermaidCodeFence(info?: string) {
  return info?.trim().split(/\s+/, 1)[0]?.toLowerCase() === 'mermaid';
}

export function isCompleteMermaidFence(raw?: string) {
  if (!raw) return true;

  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
  if (!opening) return true;
  if (!opening[0].includes('\n')) return false;

  const marker = opening[1]![0]!;
  const body = raw.slice(opening[0].length);
  return new RegExp(`(?:^|\\r?\\n) {0,3}${marker}{${opening[1]!.length},}[\\t ]*(?:\\r?\\n)?$`).test(body);
}

export function mermaidSourceUsesBlockedAssets(source: string) {
  if (mermaidSourceUsesConfiguration(source)) return true;

  const normalized = decodeHtmlEntities(decodeYamlEscapes(source));
  if (sourceUsesResourceMarkup(normalized)) return true;
  if (/(?:[{,]\s*|^ {0,3})["']?(?:img|image|icon)["']?\s*:/im.test(normalized)) return true;
  if (/\$(?:image|sprite)\s*=/i.test(normalized) || cssUsesExternalContent(normalized)) return true;
  return false;
}

export async function renderMermaidSvg(source: string, themeMode: MermaidThemeMode) {
  if (source.length > MERMAID_SOURCE_MAX_LENGTH) {
    throw new Error(`Diagram source exceeds the ${MERMAID_SOURCE_MAX_LENGTH.toLocaleString()} character limit.`);
  }
  if (mermaidSourceUsesBlockedAssets(source)) {
    throw new Error('Diagram configuration, images, and external styles are disabled in chat diagrams.');
  }

  const render = mermaidRenderQueue.then(async () => {
    const mermaid = await getMermaid();
    mermaid.initialize(mermaidConfig(themeMode));
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    if (parsedMermaidDataUsesBlockedAssets(diagram.db)) throw new Error('Diagram configuration, images, and external styles are disabled in chat diagrams.');
    const { svg } = await mermaid.render(`pi-mermaid-${++mermaidRenderId}`, source);
    return removeMermaidExternalContent(svg);
  });

  mermaidRenderQueue = render.then(() => undefined, () => undefined);
  return render;
}

function getMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return mermaidPromise;
}

function removeMermaidExternalContent(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror')) throw new Error('Mermaid returned invalid SVG.');

  document.querySelectorAll('image, feImage, img, iframe, object, embed, audio, video, source, script').forEach((element) => element.remove());
  document.querySelectorAll('a').forEach((link) => link.replaceWith(...Array.from(link.childNodes)));
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      if ((name === 'href' || name === 'src') && !attribute.value.trim().startsWith('#')) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (cssUsesExternalContent(attribute.value)) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (cssContainsResourceSyntax(attribute.value)) element.setAttributeNS(attribute.namespaceURI, attribute.name, localOnlyCss(attribute.value));
    }
  });
  document.querySelectorAll('style').forEach((style) => {
    const css = style.textContent ?? '';
    style.textContent = cssUsesExternalContent(css) ? '' : localOnlyCss(css);
  });

  return new XMLSerializer().serializeToString(document.documentElement);
}

function mermaidSourceUsesConfiguration(source: string) {
  const withoutBom = source.replace(/^\uFEFF/, '');
  return /^[^\S\r\n]*---[^\S\r\n]*(?:\r\n|[\r\n]|$)/.test(withoutBom) || /%%\s*\{/i.test(withoutBom);
}

function sourceUsesResourceMarkup(source: string) {
  if (/!\[[^\]\r\n]*\]\(\s*/.test(source)) return true;
  const withoutLineBreaks = source.replace(/<\s*br\s*\/?\s*>/gi, '');
  return /<\s*\/?\s*[a-z][\w:-]*(?=[\s/>])/i.test(withoutLineBreaks);
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", bsol: '\\', colon: ':', gt: '>', lpar: '(', lt: '<', newline: '\n', num: '#', quot: '"', rpar: ')', sol: '/', tab: '\t',
  };
  return value
    .replace(/&#(?:x([\da-f]+)|([\d]+));?/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
      try {
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      } catch {
        return entity;
      }
    })
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function localOnlyCss(value: string) {
  return canonicalCss(value)
    .replace(/@import\b[^;}]*(?:;|$)/gi, '')
    .replace(/url\s*\(\s*([^)]+)\)/gi, (url, target: string) => {
      const normalized = target.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
      return normalized.startsWith('#') ? url : 'none';
    });
}

function canonicalCss(value: string) {
  let normalized = value;
  for (let pass = 0; pass < 8; pass++) {
    const next = normalized
      .replace(/\\(?:\r\n|[\n\r\f])/g, '')
      .replace(/\\([\da-f]{1,6})(?:\r\n|[\t \n\r\f])?|\\([^\n\r\f])/gi, (_escape, hex: string | undefined, character: string | undefined) => {
        if (character !== undefined) return character;
        const codePoint = Number.parseInt(hex ?? '', 16);
        if (!codePoint || codePoint > 0x10ffff) return '\uFFFD';
        return String.fromCodePoint(codePoint);
      })
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (next === normalized) return next;
    normalized = next;
  }
  return normalized;
}

function decodeYamlEscapes(value: string) {
  return value.replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|U([\da-f]{8}))/gi, (_escape, short: string | undefined, medium: string | undefined, long: string | undefined) => {
    const codePoint = Number.parseInt(short ?? medium ?? long ?? '', 16);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return _escape;
    }
  });
}

function cssContainsResourceSyntax(value: string) {
  return /@import\b|(?:url|src|image|image-set|cross-fade)\s*\(/i.test(canonicalCss(value));
}

function cssUsesExternalContent(value: string) {
  const normalized = canonicalCss(value);
  if (/@import\b|(?:src|image|image-set|cross-fade)\s*\(/i.test(normalized)) return true;
  for (const match of normalized.matchAll(/url\s*\(\s*([^)]+)\)/gi)) {
    const target = match[1]!.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!target.startsWith('#')) return true;
  }
  return false;
}

function parsedMermaidDataUsesBlockedAssets(root: unknown) {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let inspected = 0;

  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (cssUsesExternalContent(decodeYamlEscapes(value))) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    if (++inspected > 50_000) return true;
    seen.add(value);

    if (value instanceof Map) {
      for (const [key, entry] of value) {
        if (blockedAssetProperty(key, entry)) return true;
        pending.push(entry);
      }
      continue;
    }
    if (value instanceof Set) {
      pending.push(...value);
      continue;
    }

    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      if (blockedAssetProperty(key, descriptor.value)) return true;
      pending.push(descriptor.value);
    }
  }
  return false;
}

function blockedAssetProperty(key: unknown, value: unknown) {
  if (typeof key !== 'string' || value === undefined || value === null || value === '') return false;
  const normalized = decodeYamlEscapes(key).toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'img' || normalized === 'image' || normalized === 'imageurl') return true;
  if (normalized !== 'icon' && normalized !== 'sprite' && normalized !== 'src') return false;
  return typeof value === 'string' && /^(?:https?:|data:|blob:|file:|\/|\.\.?\/)|[/.]/i.test(value.trim());
}

function mermaidConfig(themeMode: MermaidThemeMode): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
    maxEdges: 500,
    logLevel: 'fatal',
    theme: themeMode === 'dark' ? 'neo-dark' : 'neo',
    darkMode: themeMode === 'dark',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    htmlLabels: false,
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'suppressErrorRendering',
      'maxTextSize',
      'maxEdges',
      'theme',
      'themeVariables',
      'themeCSS',
      'darkMode',
      'fontFamily',
      'htmlLabels',
      'dompurifyConfig',
    ],
  };
}
