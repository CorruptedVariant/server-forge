// Reading and editing .properties files (Minecraft's server.properties) without disturbing anything we don't change,
// plus a schema parsed from the official Bedrock template (descriptions and allowed values come from its comments).
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export interface PropertyInfo {
  key: string;
  /** Value shipped in the official file (the default). */
  defaultValue: string;
  description: string;
  /** 'boolean', 'number', 'select' (options) or 'text'. */
  type: 'boolean' | 'number' | 'select' | 'text';
  options?: string[];
  /** Commented out in the official file: optional/advanced. */
  optional: boolean;
}

function stripBom(text: string) {
  return text.replace(/^﻿/, '');
}

/** Parses the official template: each "key=value" (or "# key=value" for optional ones) followed by its comment lines. */
export function parseTemplate(text: string): PropertyInfo[] {
  const lines = stripBom(text).split(/\r?\n/);
  const result: PropertyInfo[] = [];
  let current: PropertyInfo | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const entry = /^(#\s*)?([a-z0-9][a-z0-9.\-_]*)=(.*)$/i.exec(line);
    if (entry && (!entry[1] || !current)) {
      current = { key: entry[2], defaultValue: entry[3], description: '', type: 'text', optional: !!entry[1] };
      result.push(current);
      continue;
    }
    if (!line) {
      current = null;
      continue;
    }
    if (current && line.startsWith('#')) {
      const text = line.replace(/^#\s?/, '');
      current.description += (current.description ? '\n' : '') + text;
    }
  }
  for (const info of result) {
    const allowed = /Allowed values:\s*(.*)/i.exec(info.description)?.[1] ?? '';
    const quoted = [...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (/^"?true"? or "?false"?|^true, false/i.test(allowed) || ['true', 'false'].includes(info.defaultValue)) info.type = 'boolean';
    else if (quoted.length >= 2) {
      info.type = 'select';
      info.options = quoted;
    } else if (/integer|\[\d+, ?\d+\]|0-\d+|positive|non-negative/i.test(allowed) && /^-?\d*$/.test(info.defaultValue)) info.type = 'number';
  }
  return result;
}

export interface PropertiesFile {
  file: string;
  values: Map<string, string>;
  lines: string[];
}

export function readProperties(file: string): PropertiesFile {
  const lines = existsSync(file) ? stripBom(readFileSync(file, 'utf-8')).split(/\r?\n/) : [];
  const values = new Map<string, string>();
  for (const line of lines) {
    const m = /^([^#=\s][^=]*?)=(.*)$/.exec(line.trim());
    if (m) values.set(m[1], m[2]);
  }
  return { file, values, lines };
}

function validValue(key: string, value: string) {
  if (/[\r\n]/.test(value)) throw new Error(`${key}: the value can't contain line breaks.`);
}

/**
 * Changes only the given keys: existing lines are updated in place, missing keys are appended. Everything else
 * (comments, order, unknown keys) stays exactly as it was. Writes atomically.
 */
export function writeProperties(file: string, changes: Record<string, string>, describe?: (key: string) => string | undefined) {
  const { lines } = readProperties(file);
  const pending = new Map(Object.entries(changes));
  for (const [key, value] of pending) validValue(key, value);
  const out = lines.map((line) => {
    const m = /^(\s*)([^#=\s][^=]*?)=(.*)$/.exec(line);
    if (m && pending.has(m[2])) {
      const value = pending.get(m[2])!;
      pending.delete(m[2]);
      return `${m[1]}${m[2]}=${value}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const [key, value] of pending) {
    out.push('', `${key}=${value}`);
    const help = describe?.(key);
    if (help) out.push(...help.split('\n').map((l) => `# ${l}`));
  }
  writePropertiesText(file, out.join('\r\n') + '\r\n');
}

/** Replaces a properties file atomically when the caller needs to preserve its exact formatting. */
export function writePropertiesText(file: string, text: string) {
  const tmp = `${file}.tavernhost-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Keeps a timestamped copy next to the file before a big change. */
export function backupFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const copy = path.join(path.dirname(file), `${path.basename(file)}.backup-${stamp}`);
  copyFileSync(file, copy);
  return copy;
}
