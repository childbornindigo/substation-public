import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const MAX_BYTES = 64 * 1024;
const START = '<!-- substation-warm-handoff:start -->';
const END = '<!-- substation-warm-handoff:end -->';
const HEADINGS = ['Goal', 'Status', 'Decisions', 'Dead ends', 'Files', 'Verification', 'Next steps', 'Open questions'];
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = s => `${s.dev}:${s.ino}:${s.uid}:${s.nlink}:${s.mode}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const pins = r => ({ session: r.session, generation: r.generation, account: r.account, model: r.model, prefix: r.prefix });
function equalPins(a, b) { return a && b && Object.keys(pins(a)).every(k => a[k] !== undefined && a[k] === b[k]); }
function sections(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('strict handoff sections required');
  if (!Object.keys(value).length || Object.keys(value).some(k => !HEADINGS.includes(k))) throw new Error('unknown handoff section');
  if (typeof value.Status !== 'string' || !value.Status.trim()) throw new Error('handoff Status required');
  for (const text of Object.values(value)) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_BYTES / 4 || /\x00|<!--\s*substation-warm-handoff/i.test(text)) throw new Error('invalid handoff section text');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('handoff output bound');
  return { ...value };
}
function noAlias(p) {
  for (let q = path.resolve(p); ; q = path.dirname(q)) {
    if (fs.lstatSync(q).isSymbolicLink()) throw new Error('symlink target ancestry refused');
    if (q === path.dirname(q)) break;
  }
}
function fileState(p) {
  const initial = fs.lstatSync(p);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== process.getuid() || initial.nlink !== 1 || initial.mode & 0o022 || initial.size > 1024 * 1024) throw new Error('unowned/aliased/bounded target refused');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || s.mode & 0o022 || s.size > 1024 * 1024) throw new Error('unowned/aliased/bounded target refused');
    if (identity(s) !== identity(initial)) throw new Error('target changed before open');
    const buffer = Buffer.alloc(1024 * 1024 + 1); let size = 0;
    while (size < buffer.length) { const count = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    if (size > 1024 * 1024) throw new Error('target read bound');
    const bytes = buffer.subarray(0, size);
    if (identity(fs.fstatSync(fd)) !== identity(s) || identity(fs.lstatSync(p)) !== identity(s)) throw new Error('target changed during read');
    return { fingerprint: `${identity(s)}:${sha(bytes)}`, bytes, mode: s.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function directoryState(p) {
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o022) throw new Error('unowned target directory refused');
  return `${s.dev}:${s.ino}:${s.uid}:${s.mode}`;
}
function merge(original, content) {
  const begin = original.indexOf(START), finish = original.indexOf(END);
  if ((begin === -1) !== (finish === -1) || (begin !== -1 && (finish < begin || original.indexOf(START, begin + START.length) !== -1 || original.indexOf(END, finish + END.length) !== -1))) throw new Error('ambiguous managed handoff section');
  const block = `${START}\n## Warm Cache Handoff\n\n${HEADINGS.filter(k => content[k]).map(k => `### ${k}\n${content[k]}\n`).join('\n')}\n${END}`;
  return begin === -1 ? `${original}${original.endsWith('\n') ? '' : '\n'}\n${block}\n` : original.slice(0, begin) + block + original.slice(finish + END.length);
}

// This writer is staged OFF. Every live writer of a registered target must share
// the exclusive lock before activation; SHA CAS alone cannot serialize rh.sh.
export class AtomicSectionWriter {
  constructor({ root, destinations }) {
    this.root = path.resolve(root);
    if (!this.root.endsWith(`${path.sep}memory${path.sep}active`) || this.root.split(path.sep).includes('Volumes')) throw new Error('canonical internal memory/active root required');
    this.destinations = structuredClone(destinations);
  }
  resolve(record) {
    const entry = this.destinations[record.session];
    if (!entry || entry.generation !== record.generation || typeof record.generation !== 'string' || !/^[a-f0-9]{64}$/.test(record.generation)) throw new Error('unregistered session generation');
    const target = path.resolve(entry.path);
    if (path.dirname(target) !== this.root || !target.endsWith('.md')) throw new Error('unregistered canonical target');
    noAlias(target);
    return { target, rootIdentity: directoryState(this.root) };
  }
  prepare(record) {
    const { target, rootIdentity } = this.resolve(record);
    return { pins: pins(record), target, rootIdentity, targetFingerprint: fileState(target).fingerprint };
  }
  write(record, result, prepared = result?.prepared) {
    if (!equalPins(record, result?.pins) || !equalPins(record, prepared?.pins)) throw new Error('handoff identity drift');
    const { target, rootIdentity } = this.resolve(record);
    if (target !== prepared.target || rootIdentity !== prepared.rootIdentity) throw new Error('target parent drift');
    const lockPath = `${target}.warm-handoff.lock`;
    let lock, temporary, lockIdentity;
    try {
      lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      lockIdentity = identity(fs.fstatSync(lock));
      fs.fsyncSync(lock);
      const current = fileState(target);
      if (current.fingerprint !== prepared.targetFingerprint) throw new Error('target CAS changed');
      const originalText = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes);
      const content = Buffer.from(merge(originalText, sections(result.sections)));
      if (content.length > 1024 * 1024) throw new Error('merged target bound');
      temporary = path.join(this.root, `.warm-handoff-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, current.mode);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const again = this.resolve(record);
      if (again.rootIdentity !== prepared.rootIdentity || fileState(target).fingerprint !== prepared.targetFingerprint) throw new Error('target CAS changed before publication');
      fs.renameSync(temporary, target); temporary = undefined;
      const parent = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return { targetFingerprint: fileState(target).fingerprint, bytes: content.length, written: true };
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (lock !== undefined) { fs.closeSync(lock); if (identity(fs.lstatSync(lockPath)) !== lockIdentity) throw new Error('writer lock identity changed'); fs.unlinkSync(lockPath); }
    }
  }
}

export function createSummaryAdapter({ getContext, invoke, prepare }) {
  return async (record, { signal } = {}) => {
    if (signal?.aborted) throw Error("handoff cancelled before context");
    const context = await getContext(record);
    if (!equalPins(record, context) || !Array.isArray(context.messages) || !Array.isArray(context.tools) || !context.messages.length) throw new Error('unknown or changed cacheable context');
    const exact = JSON.parse(JSON.stringify(context));
    const inputHash = sha(JSON.stringify({ messages: exact.messages, tools: exact.tools }));
    const prepared = prepare ? await prepare(record) : undefined;
    const handoffRequestId = randomUUID();
    if (signal?.aborted) throw Error("handoff cancelled before dispatch");
    const response = await invoke({ ...exact, signal, handoffRequestId, origin: 'warm-handoff', messages: [...exact.messages, { role: 'user', content: 'Write only a JSON object of handoff sections: Goal, Status, Decisions, Dead ends, Files, Verification, Next steps, Open questions. Status is required. Summarize existing context only. Exclude credentials, tokens, secrets and verbatim private messages. Do not execute tools, send notifications, commit, deploy, or change any file. No Markdown fences.' }], summaryOnly: true, executeTools: false, notifications: false, tool_choice: 'none' });
    if (signal?.aborted) throw Error('handoff cancelled after inference');
    if (inputHash !== sha(JSON.stringify({ messages: exact.messages, tools: exact.tools }))) throw new Error('cacheable context mutated');
    if (!response || response.handoffRequestId !== handoffRequestId || response.fallback || (!Array.isArray(response.toolCalls) || response.toolCalls.length !== 0) || !equalPins(record, response.pins)) throw new Error('unserved or tool-bearing handoff refused');
    const usage = response.usage;
    if (!usage || usage.usage_complete !== true || usage.provider_model !== record.model || usage.account !== record.account || !Number.isSafeInteger(usage.cache_read) || usage.cache_read <= 0) throw new Error('warm provider usage unconfirmed');
    if (typeof response.text !== 'string' || Buffer.byteLength(response.text) > MAX_BYTES) throw new Error('bounded strict JSON handoff required');
    const result = sections(JSON.parse(response.text));
    return { sections: result, usage: { ...usage }, pins: pins(record), handoffRequestId, prepared };
  };
}

export function nativeAdapterReadiness(observation) {
  // Direct native sessions have no qualified provider/request-start contract yet.
  return { enabled: false, reason: 'native cache TTL and delivery contract unqualified', measuredTtl: null };
}
