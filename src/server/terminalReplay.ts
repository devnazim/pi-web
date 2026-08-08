const CSI_FINAL_BYTE_START = 0x40;
const CSI_FINAL_BYTE_END = 0x7e;
const ESCAPE_INTERMEDIATE_BYTE_START = 0x20;
const ESCAPE_INTERMEDIATE_BYTE_END = 0x2f;
const ESCAPE_FINAL_BYTE_START = 0x30;
const ESCAPE_FINAL_BYTE_END = 0x7e;
const MAX_PENDING_CONTROL_SEQUENCE_LENGTH = 64 * 1024;

type TerminalControlSequenceMode = 'ground' | 'escape' | 'csi' | 'osc' | 'string';
type SequenceScan = { type: 'complete'; end: number } | { type: 'cancel'; next: number } | { type: 'restart'; next: number } | { type: 'pending' };

export type TerminalReplaySanitizerState = {
  mode: TerminalControlSequenceMode;
  sequenceParts: string[];
  sequenceLength: number;
  discarding: boolean;
  escapeIntermediate: boolean;
  stringEscape: boolean;
};

export type SanitizedTerminalReplayChunk = {
  data: string;
  state: TerminalReplaySanitizerState;
  settled?: {
    consumed: number;
    dataLength: number;
    livePrefix: string;
    responseQuery?: string;
  };
};

export type TerminalReplayEntry = { cols: number; rows: number; data: string };

export function createTerminalReplaySanitizerState(): TerminalReplaySanitizerState {
  return {
    mode: 'ground',
    sequenceParts: [],
    sequenceLength: 0,
    discarding: false,
    escapeIntermediate: false,
    stringEscape: false,
  };
}

export function terminalReplaySanitizerIsGround(state: TerminalReplaySanitizerState) {
  return state.mode === 'ground';
}

export function trimTerminalReplay(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const preferredStart = value.length - Math.max(1, Math.floor(maxLength * 0.75));
  let safeStart = preferredStart;
  let index = 0;

  while (index < value.length) {
    const sequenceEnd = completeControlSequenceEnd(value, index);
    if (sequenceEnd !== undefined) {
      if (index <= preferredStart && preferredStart < sequenceEnd) safeStart = sequenceEnd;
      index = sequenceEnd;
      continue;
    }
    if (index >= preferredStart && value.charCodeAt(index) === 0x0a) return value.slice(index + 1);
    index += 1;
  }

  if (safeStart > 0 && isLowSurrogate(value.charCodeAt(safeStart)) && isHighSurrogate(value.charCodeAt(safeStart - 1))) safeStart += 1;
  return value.slice(safeStart);
}

export function appendTerminalReplayData(entries: TerminalReplayEntry[], data: string, maxDataLength: number, maxEntries: number) {
  if (!data || !entries.length) return;
  entries[entries.length - 1].data += data;
  trimTerminalReplayEntries(entries, maxDataLength, maxEntries);
}

export function recordTerminalReplayResize(entries: TerminalReplayEntry[], cols: number, rows: number, maxDataLength: number, maxEntries: number) {
  const last = entries.at(-1);
  if (!last) {
    entries.push({ cols, rows, data: '' });
  } else if (last.cols === cols && last.rows === rows) {
    return;
  } else if (!last.data) {
    last.cols = cols;
    last.rows = rows;
  } else {
    entries.push({ cols, rows, data: '' });
  }
  trimTerminalReplayEntries(entries, maxDataLength, maxEntries);
}

export function trimTerminalReplayEntries(entries: TerminalReplayEntry[], maxDataLength: number, maxEntries: number) {
  const entryLimit = Math.max(1, maxEntries);
  const dataLimit = Math.max(1, maxDataLength);
  while (entries.length > entryLimit && entries.length > 1) entries.shift();

  let totalDataLength = entries.reduce((total, entry) => total + entry.data.length, 0);
  while (totalDataLength > dataLimit && entries.length > 1) {
    const first = entries[0];
    const remainingDataLength = totalDataLength - first.data.length;
    if (!first.data || remainingDataLength >= dataLimit) {
      entries.shift();
      totalDataLength = remainingDataLength;
      continue;
    }
    first.data = trimTerminalReplay(first.data, dataLimit - remainingDataLength);
    totalDataLength = remainingDataLength + first.data.length;
  }

  if (entries.length === 1 && totalDataLength > dataLimit) entries[0].data = trimTerminalReplay(entries[0].data, dataLimit);
}

export function sanitizeTerminalReplayChunk(state: TerminalReplaySanitizerState, data: string): SanitizedTerminalReplayChunk {
  const startedPending = state.mode !== 'ground';
  const sanitized: string[] = [];
  let sanitizedLength = 0;
  let settled: SanitizedTerminalReplayChunk['settled'];
  let sequenceStart = startedPending ? 0 : -1;
  let stringEscapeIndex = -1;
  let index = 0;

  const emit = (value: string) => {
    if (!value) return;
    sanitized.push(value);
    sanitizedLength += value.length;
  };
  const markSettled = (consumed: number, livePrefix = '', responseQuery?: string) => {
    if (startedPending && !settled) settled = { consumed, dataLength: sanitizedLength, livePrefix, ...(responseQuery ? { responseQuery } : {}) };
  };
  const clearSequence = () => {
    state.sequenceParts = [];
    state.sequenceLength = 0;
    state.discarding = false;
    state.escapeIntermediate = false;
    state.stringEscape = false;
  };
  const resetToGround = () => {
    state.mode = 'ground';
    clearSequence();
    sequenceStart = -1;
    stringEscapeIndex = -1;
  };
  const appendSequence = (start: number, end: number) => {
    if (state.discarding || start < 0 || end <= start) return;
    const length = end - start;
    if (state.sequenceLength + length > MAX_PENDING_CONTROL_SEQUENCE_LENGTH) {
      state.sequenceParts = [];
      state.sequenceLength = 0;
      state.discarding = true;
      return;
    }
    state.sequenceParts.push(data.slice(start, end));
    state.sequenceLength += length;
  };
  const completeSequence = (end: number, unsafe: (sequence: string) => boolean = () => false) => {
    appendSequence(sequenceStart, end);
    let responseQuery: string | undefined;
    if (!state.discarding) {
      const sequence = state.sequenceParts.join('');
      if (terminalSequenceExpectsResponse(sequence)) responseQuery = sequence;
      else if (!unsafe(sequence)) emit(sequence);
    }
    resetToGround();
    return responseQuery;
  };
  const startSequence = (mode: Exclude<TerminalControlSequenceMode, 'ground'>, start: number) => {
    clearSequence();
    state.mode = mode;
    sequenceStart = start;
  };

  while (index < data.length) {
    if (state.mode === 'ground') {
      const start = index;
      while (index < data.length && !isSequenceIntroducer(data.charCodeAt(index))) index += 1;
      emit(data.slice(start, index));
      if (index >= data.length) break;
      const code = data.charCodeAt(index);
      if (code === 0x1b) startSequence('escape', index);
      else if (code === 0x9b) startSequence('csi', index);
      else startSequence(code === 0x9d ? 'osc' : 'string', index);
      index += 1;
      continue;
    }

    const code = data.charCodeAt(index);

    if (state.mode === 'escape') {
      if (!state.escapeIntermediate && code === 0x5b) {
        state.mode = 'csi';
        index += 1;
        continue;
      }
      if (!state.escapeIntermediate && escapeStringKind(code)) {
        state.mode = code === 0x5d ? 'osc' : 'string';
        index += 1;
        continue;
      }
      if (code >= ESCAPE_INTERMEDIATE_BYTE_START && code <= ESCAPE_INTERMEDIATE_BYTE_END) {
        state.escapeIntermediate = true;
        index += 1;
        continue;
      }
      if (code === 0x18 || code === 0x1a) {
        resetToGround();
        index += 1;
        markSettled(index);
        continue;
      }
      if (code === 0x1b || isC1SequenceIntroducer(code)) {
        resetToGround();
        markSettled(index);
        continue;
      }
      if (isC1Control(code)) {
        resetToGround();
        emit(data[index] ?? '');
        index += 1;
        markSettled(index);
        continue;
      }
      if (isExecutableC0(code) || code === 0x7f) {
        appendSequence(sequenceStart, index);
        sequenceStart = index + 1;
        if (code !== 0x7f) emit(data[index] ?? '');
        index += 1;
        continue;
      }
      if (code >= ESCAPE_FINAL_BYTE_START && code <= ESCAPE_FINAL_BYTE_END) {
        const responseQuery = completeSequence(index + 1);
        index += 1;
        markSettled(index, '', responseQuery);
        continue;
      }
      resetToGround();
      markSettled(index);
      continue;
    }

    if (state.mode === 'csi') {
      if (code === 0x18 || code === 0x1a) {
        resetToGround();
        index += 1;
        markSettled(index);
        continue;
      }
      if (code === 0x1b || isC1SequenceIntroducer(code)) {
        resetToGround();
        markSettled(index);
        continue;
      }
      if (isC1Control(code)) {
        resetToGround();
        emit(data[index] ?? '');
        index += 1;
        markSettled(index);
        continue;
      }
      if (isExecutableC0(code) || code === 0x7f) {
        appendSequence(sequenceStart, index);
        sequenceStart = index + 1;
        if (code !== 0x7f) emit(data[index] ?? '');
        index += 1;
        continue;
      }
      if (code >= CSI_FINAL_BYTE_START && code <= CSI_FINAL_BYTE_END) {
        const responseQuery = completeSequence(index + 1, isReplayUnsafeCsiSequence);
        index += 1;
        markSettled(index, '', responseQuery);
        continue;
      }
      index += 1;
      continue;
    }

    if (state.stringEscape) {
      if (code === 0x5c) {
        const responseQuery = completeSequence(index + 1, state.mode === 'osc' ? isReplayUnsafeOscSequence : isReplayUnsafeStringSequence);
        index += 1;
        markSettled(index, '', responseQuery);
        continue;
      }

      const escapeWasInCurrentChunk = stringEscapeIndex >= 0;
      const restartIndex = escapeWasInCurrentChunk ? stringEscapeIndex : 0;
      clearSequence();
      state.mode = 'escape';
      if (escapeWasInCurrentChunk) {
        sequenceStart = restartIndex;
      } else {
        state.sequenceParts = ['\x1b'];
        state.sequenceLength = 1;
        sequenceStart = 0;
      }
      markSettled(restartIndex, escapeWasInCurrentChunk ? '' : '\x1b');
      stringEscapeIndex = -1;
      continue;
    }

    if ((state.mode === 'osc' && code === 0x07) || code === 0x9c) {
      const responseQuery = completeSequence(index + 1, state.mode === 'osc' ? isReplayUnsafeOscSequence : isReplayUnsafeStringSequence);
      index += 1;
      markSettled(index, '', responseQuery);
      continue;
    }
    if (code === 0x18 || code === 0x1a) {
      resetToGround();
      index += 1;
      markSettled(index);
      continue;
    }
    if (code === 0x1b) {
      state.stringEscape = true;
      stringEscapeIndex = index;
      index += 1;
      continue;
    }
    if (isC1SequenceIntroducer(code)) {
      resetToGround();
      markSettled(index);
      continue;
    }
    if (isC1Control(code)) {
      resetToGround();
      emit(data[index] ?? '');
      index += 1;
      markSettled(index);
      continue;
    }
    index += 1;
  }

  if (state.mode !== 'ground') appendSequence(sequenceStart, data.length);
  const result: SanitizedTerminalReplayChunk = { data: sanitized.join(''), state };
  if (settled) result.settled = settled;
  return result;
}

function completeControlSequenceEnd(input: string, start: number) {
  const code = input.charCodeAt(start);
  if (code === 0x1b) return completedSequenceEnd(scanEscapeSequence(input, start + 1));
  if (code === 0x9b) return completedSequenceEnd(scanCsiSequence(input, start + 1));
  const stringKind = c1StringKind(code);
  return stringKind ? completedSequenceEnd(scanStringSequence(input, start + 1, stringKind === 'osc')) : undefined;
}

function scanCsiSequence(input: string, start: number): SequenceScan {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x18 || code === 0x1a) return { type: 'cancel', next: index + 1 };
    if (code === 0x1b || isC1Control(code)) return { type: 'restart', next: index };
    if (code >= CSI_FINAL_BYTE_START && code <= CSI_FINAL_BYTE_END) return { type: 'complete', end: index + 1 };
  }
  return { type: 'pending' };
}

function scanStringSequence(input: string, start: number, allowBel: boolean): SequenceScan {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if ((allowBel && code === 0x07) || code === 0x9c) return { type: 'complete', end: index + 1 };
    if (code === 0x18 || code === 0x1a) return { type: 'cancel', next: index + 1 };
    if (code === 0x1b) {
      if (index + 1 >= input.length) return { type: 'pending' };
      if (input.charCodeAt(index + 1) === 0x5c) return { type: 'complete', end: index + 2 };
      return { type: 'restart', next: index };
    }
    if (isC1Control(code)) return { type: 'restart', next: index };
  }
  return { type: 'pending' };
}

function scanEscapeSequence(input: string, start: number): SequenceScan {
  let index = start;
  let hasIntermediate = false;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (isExecutableC0(code) || code === 0x7f) {
      index += 1;
      continue;
    }
    if (code >= ESCAPE_INTERMEDIATE_BYTE_START && code <= ESCAPE_INTERMEDIATE_BYTE_END) {
      hasIntermediate = true;
      index += 1;
      continue;
    }
    break;
  }
  if (index >= input.length) return { type: 'pending' };
  const code = input.charCodeAt(index);
  if (!hasIntermediate && code === 0x5b) return scanCsiSequence(input, index + 1);
  if (!hasIntermediate) {
    const stringKind = escapeStringKind(code);
    if (stringKind) return scanStringSequence(input, index + 1, stringKind === 'osc');
  }
  if (code === 0x18 || code === 0x1a) return { type: 'cancel', next: index + 1 };
  if (code === 0x1b || isC1Control(code)) return { type: 'restart', next: index };
  if (code >= ESCAPE_FINAL_BYTE_START && code <= ESCAPE_FINAL_BYTE_END) return { type: 'complete', end: index + 1 };
  return { type: 'restart', next: index };
}

function completedSequenceEnd(scan: SequenceScan) {
  return scan.type === 'complete' ? scan.end : undefined;
}

function isSequenceIntroducer(code: number) {
  return code === 0x1b || code === 0x9b || Boolean(c1StringKind(code));
}

function isExecutableC0(code: number) {
  return code <= 0x1f && code !== 0x18 && code !== 0x1a && code !== 0x1b;
}

function isC1Control(code: number) {
  return code >= 0x80 && code <= 0x9f;
}

function escapeStringKind(introducer: number): 'osc' | 'string' | undefined {
  if (introducer === 0x5d) return 'osc';
  return introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f ? 'string' : undefined;
}

function c1StringKind(introducer: number): 'osc' | 'string' | undefined {
  if (introducer === 0x9d) return 'osc';
  return introducer === 0x90 || introducer === 0x98 || introducer === 0x9e || introducer === 0x9f ? 'string' : undefined;
}

function isC1SequenceIntroducer(code: number) {
  return code === 0x90 || code === 0x98 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isReplayUnsafeCsiSequence(sequence: string) {
  const introducerLength = sequence.startsWith('\x1b[') ? 2 : 1;
  const finalByte = sequence.at(-1) ?? '';
  const body = sequence.slice(introducerLength, -1);
  if (finalByte === 'n') return true;
  if (finalByte === 'R') return /^[?0-9;]*$/.test(body);
  return finalByte === 'c' && /^[=>?0-9;]*$/.test(body);
}

function isReplayUnsafeOscSequence(sequence: string) {
  return isColorQuery(sequence);
}

function isReplayUnsafeStringSequence(sequence: string) {
  return isStatusStringQuery(sequence);
}

function terminalSequenceExpectsResponse(sequence: string) {
  if (sequence.startsWith('\x1b[') || sequence.startsWith('\x9b')) {
    const introducerLength = sequence.startsWith('\x1b[') ? 2 : 1;
    const finalByte = sequence.at(-1) ?? '';
    const body = sequence.slice(introducerLength, -1);
    if (finalByte === 'c') return /^(?:0|>|>0|=|=0)?$/.test(body);
    if (finalByte === 'n') return /^(?:5|6|\?6)$/.test(body);
    if (finalByte === 'p') return /^\??[0-9;]*\$$/.test(body);
    if (finalByte === 't') return /^(?:14(?:;[02])?|16|18)$/.test(body);
    return false;
  }
  return isColorQuery(sequence) || isStatusStringQuery(sequence);
}

function isColorQuery(sequence: string) {
  if (!sequence.startsWith('\x1b]') && !sequence.startsWith('\x9d')) return false;
  const introducerLength = sequence.startsWith('\x1b]') ? 2 : 1;
  const contentEnd = sequence.endsWith('\x1b\\') ? sequence.length - 2 : sequence.length - 1;
  const parts = sequence.slice(introducerLength, contentEnd).split(';');

  if (parts[0] === '4') {
    for (let index = 1; index + 1 < parts.length; index += 2) {
      if (/^[0-9]+$/.test(parts[index] ?? '') && parts[index + 1] === '?') return true;
    }
    return false;
  }

  const firstSelector = Number(parts[0]);
  if (!Number.isInteger(firstSelector) || firstSelector < 10 || firstSelector > 12) return false;
  return parts.slice(1, 14 - firstSelector).some((value) => value === '?');
}

function isStatusStringQuery(sequence: string) {
  if (!sequence.startsWith('\x1bP') && !sequence.startsWith('\x90')) return false;
  const introducerLength = sequence.startsWith('\x1bP') ? 2 : 1;
  const contentEnd = sequence.endsWith('\x1b\\') ? sequence.length - 2 : sequence.length - 1;
  return sequence.slice(introducerLength, contentEnd).startsWith('$q');
}
