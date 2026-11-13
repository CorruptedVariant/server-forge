// Accounts, password hashing, login sessions and API keys.
import { randomBytes, scryptSync, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { readJson, writeJson } from './store.ts';
import { grantsFor, normalizeGrants, assertCanGrant, type Grants, type GlobalPerm, type Preset, type Principal } from './permissions.ts';

export type Role = 'owner' | Preset;

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  /** Ignored for the owner, who can do everything. */
  grants?: Grants;
  /** May log in from other devices when remote access is on. */
  remote: boolean;
  disabled?: boolean;
  /** Has to choose a new password before doing anything else (after a reset, or set when created). */
  mustChangePassword?: boolean;
  /** Free text for the owner/admins, e.g. "Discord: Bob#1234, moderator for the SMP". */
  note?: string;
  createdAt: number;
  createdBy?: string;
  lastLogin?: number;
  lastLoginIp?: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export interface ApiKey {
  id: string;
  name: string;
  /** sha256 of the key; the key itself is only shown once, when created. */
  keyHash: string;
  /** First characters, so keys can be told apart in the list. */
  prefix: string;
  preset: Preset;
  grants: Grants;
  createdAt: number;
  createdBy?: string;
  lastUsed?: number;
  /** Stops working after this time (null = never). */
  expiresAt?: number | null;
}

export type PublicApiKey = Omit<ApiKey, 'keyHash'>;

const USERS_FILE = 'users.json';
const KEYS_FILE = 'apikeys.json';
const SESSIONS_FILE = 'sessions.json';
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const MIN_PASSWORD = 8;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------- users ----------

function loadUsers(): User[] {
  // Accounts from before remote access existed default to remote login allowed only for the owner. Grants from
  // before the permissions rework are converted to the new, finer permissions (same access as before).
  return readJson<User[]>(USERS_FILE, []).map((u) => ({
    ...u,
    remote: u.remote ?? u.role === 'owner',
    grants: u.role === 'owner' ? undefined : u.role === 'custom' ? normalizeGrants(u.grants, null) : grantsFor(u.role as Preset, null, []),
  }));
}

function saveUsers(users: User[]) {
  writeJson(USERS_FILE, users);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length), expected);
}

function validatePassword(password: string) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
}

export function toPublic(user: User): PublicUser {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

export function hasUsers(): boolean {
  return loadUsers().length > 0;
}

export function listUsers(): (PublicUser & { sessions: number })[] {
  const now = Date.now();
  return loadUsers().map((u) => ({ ...toPublic(u), sessions: [...sessions.values()].filter((s) => s.userId === u.id && s.expires > now).length }));
}

export function firstOwner(): User | null {
  return loadUsers().find((u) => u.role === 'owner') ?? null;
}

export function getUser(id: string): User | null {
  return loadUsers().find((u) => u.id === id) ?? null;
}

export interface UserInput {
  username?: string;
  password?: string;
  role?: Role;
  grants?: unknown;
  remote?: boolean;
  disabled?: boolean;
  mustChangePassword?: boolean;
  note?: string;
}

const ROLES: Role[] = ['owner', 'admin', 'operator', 'viewer', 'custom'];

function validUsername(raw: unknown) {
  const name = String(raw ?? '').trim();
  if (!/^[\w.-]{3,32}$/.test(name)) throw new Error('Username must be 3-32 characters: letters, numbers, . _ -');
  return name;
}

/** The first account (from setup) is the owner; everyone else is created by the owner or someone with "Manage users". */
export function createUser(input: UserInput, serverIds: string[], by: Principal | null = null): User {
  if (input.role !== undefined && !ROLES.includes(input.role)) throw new Error('Unknown role.');
  const name = validUsername(input.username);
  validatePassword(input.password ?? '');
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) throw new Error('That username is taken.');
  const role: Role = input.role ?? 'viewer';
  if (role === 'owner' && users.length > 0) throw new Error('There can only be one owner.');
  const grants = role === 'owner' ? undefined : grantsFor(role, input.grants, serverIds);
  if (by && grants) assertCanGrant(by, grants);
  const user: User = {
    id: randomUUID(),
    username: name,
    passwordHash: hashPassword(input.password as string),
    role,
    grants,
    remote: role === 'owner' ? true : !!input.remote,
    mustChangePassword: role === 'owner' ? false : !!input.mustChangePassword,
    note: String(input.note ?? '').slice(0, 500) || undefined,
    createdAt: Date.now(),
    createdBy: by?.name,
  };
  saveUsers([...users, user]);
  return user;
}

function endSessions(userId: string, keep?: string) {
  const keepKey = keep ? sha256(keep) : null;
  for (const [key, s] of sessions) if (s.userId === userId && key !== keepKey) sessions.delete(key);
  saveSessions();
}

export function updateUser(id: string, input: UserInput, serverIds: string[], by: Principal | null = null): User {
  const users = loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  if (by && !by.owner) {
    if (user.role === 'owner') throw new Error('Only the owner can change the owner account.');
    if (user.id === by.id && (input.role !== undefined || input.grants !== undefined)) throw new Error("You can't change your own permissions.");
  }
  if (input.username !== undefined && input.username !== user.username) {
    const name = validUsername(input.username);
    if (users.some((u) => u.id !== id && u.username.toLowerCase() === name.toLowerCase())) throw new Error('That username is taken.');
    user.username = name;
  }
  if (input.password) {
    validatePassword(input.password);
    user.passwordHash = hashPassword(input.password);
    // A new password logs the user out everywhere.
    endSessions(id);
  }
  if (input.role !== undefined && !ROLES.includes(input.role)) throw new Error('Unknown role.');
  if (user.role !== 'owner') {
    if (input.role && input.role !== 'owner') user.role = input.role;
    if (input.role || input.grants) {
      const grants = grantsFor(user.role as Preset, input.grants ?? user.grants, serverIds);
      if (by) assertCanGrant(by, grants);
      user.grants = grants;
    }
    if (input.disabled !== undefined) {
      user.disabled = !!input.disabled;
      if (user.disabled) endSessions(id);
    }
    if (input.mustChangePassword !== undefined) user.mustChangePassword = !!input.mustChangePassword;
  }
  if (input.remote !== undefined) user.remote = user.role === 'owner' ? true : !!input.remote;
  if (input.note !== undefined) user.note = String(input.note).slice(0, 500) || undefined;
  saveUsers(users);
  return user;
}

/** Logs a user out of every browser/device (optionally keeping the current session). */
export function signOutEverywhere(userId: string, keepToken?: string) {
  endSessions(userId, keepToken);
}

/** The user chose a new password themselves: clears "must change password". */
export function changeOwnPassword(userId: string, current: string, next: string, keepToken?: string) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user || !checkPassword(String(current ?? ''), user.passwordHash)) throw new Error('Your current password is wrong.');
  validatePassword(next);
  if (current === next) throw new Error('Choose a password different from the old one.');
  user.passwordHash = hashPassword(next);
  user.mustChangePassword = false;
  saveUsers(users);
  endSessions(userId, keepToken);
}

export function deleteUser(id: string, by: Principal | null = null): void {
  const users = loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  if (user.role === 'owner') throw new Error('The owner account cannot be deleted.');
  if (by && user.id === by.id) throw new Error("You can't delete your own account.");
  if (by && !by.owner && user.grants) assertCanGrant(by, user.grants);
  saveUsers(users.filter((u) => u.id !== id));
  endSessions(id);
}

export function verifyLogin(username: string, password: string): User | null {
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  // Hash anyway when the user doesn't exist, so response time doesn't reveal which usernames exist.
  if (!user) {
    checkPassword(password, hashPassword('dummy-password'));
    return null;
  }
  if (!checkPassword(password, user.passwordHash) || user.disabled) return null;
  user.lastLogin = Date.now();
  saveUsers(users);
  return user;
}

export function recordLoginIp(userId: string, ip: string) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return;
  user.lastLoginIp = ip;
  saveUsers(users);
}

export function userPrincipal(user: User): Principal {
  return {
    kind: 'user',
    id: user.id,
    name: user.username,
    owner: user.role === 'owner',
    grants: user.grants ?? { global: [], servers: {} },
  };
}

// ---------- sessions ----------
// sha256(token) -> session. Saved to disk so restarting the panel doesn't log everyone out; only hashes are
// stored, so the file can't be used to log in.

const sessions = new Map<string, { userId: string; expires: number }>(
  Object.entries(readJson<Record<string, { userId: string; expires: number }>>(SESSIONS_FILE, {})).filter(([, s]) => s.expires > Date.now()),
);

function saveSessions() {
  writeJson(SESSIONS_FILE, Object.fromEntries(sessions));
}

const MAX_SESSIONS_PER_USER = 20;

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(sha256(token), { userId, expires: Date.now() + SESSION_TTL_MS });
  // Keep each account's newest sessions only (the desktop app logs in every time it starts).
  const mine = [...sessions].filter(([, s]) => s.userId === userId).sort((a, b) => a[1].expires - b[1].expires);
  for (const [key] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))) sessions.delete(key);
  saveSessions();
  return token;
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const key = sha256(token);
  const session = sessions.get(key);
  if (!session || session.expires < Date.now()) {
    if (session) {
      sessions.delete(key);
      saveSessions();
    }
    return null;
  }
  const user = getUser(session.userId);
  return user && !user.disabled ? user : null;
}

export function destroySession(token: string | undefined): void {
  if (token && sessions.delete(sha256(token))) saveSessions();
}

// ---------- API keys ----------

function loadKeys(): ApiKey[] {
  // Keys from before the permissions rework get the equivalent new permissions.
  return readJson<ApiKey[]>(KEYS_FILE, []).map((k) => ({ ...k, grants: k.preset === 'custom' ? normalizeGrants(k.grants, null) : grantsFor(k.preset, null, []) }));
}

export function listApiKeys(): PublicApiKey[] {
  return loadKeys().map(({ keyHash: _, ...rest }) => rest);
}

/** Returns the new key once; only its hash is stored. `expiresInDays` 0/empty = never expires. */
export function createApiKey(
  name: string,
  preset: Preset,
  grants: unknown,
  serverIds: string[],
  by: Principal | null = null,
  expiresInDays: number | null = null,
): { key: string; apiKey: PublicApiKey } {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 60) throw new Error('Give the key a name (up to 60 characters), e.g. "Discord bot".');
  const key = `th_${randomBytes(24).toString('hex')}`;
  if (!['admin', 'operator', 'viewer', 'custom'].includes(preset)) throw new Error('Unknown access level.');
  const g = grantsFor(preset, grants, serverIds);
  if (by) assertCanGrant(by, g);
  const days = Number(expiresInDays) || 0;
  if (days < 0 || days > 3650) throw new Error('Expiry must be 1-3650 days (or never).');
  const apiKey: ApiKey = {
    id: randomUUID(),
    name: clean,
    keyHash: sha256(key),
    prefix: key.slice(0, 10),
    preset,
    grants: g,
    createdAt: Date.now(),
    createdBy: by?.name,
    expiresAt: days ? Date.now() + days * 86_400_000 : null,
  };
  writeJson(KEYS_FILE, [...loadKeys(), apiKey]);
  const { keyHash: _, ...pub } = apiKey;
  return { key, apiKey: pub };
}

/** Changes a key's name, permissions or expiry (the key itself stays the same). */
export function updateApiKey(id: string, input: { name?: string; preset?: Preset; grants?: unknown; expiresInDays?: number | null }, serverIds: string[], by: Principal | null = null) {
  const keys = loadKeys();
  const k = keys.find((x) => x.id === id);
  if (!k) throw new Error('API key not found.');
  if (by && !by.owner) assertCanGrant(by, k.grants); // can't touch keys more powerful than yourself
  if (input.name !== undefined) {
    const clean = String(input.name).trim();
    if (!clean || clean.length > 60) throw new Error('Give the key a name (up to 60 characters).');
    k.name = clean;
  }
  if (input.preset !== undefined || input.grants !== undefined) {
    const preset = (input.preset ?? k.preset) as Preset;
    if (!['admin', 'operator', 'viewer', 'custom'].includes(preset)) throw new Error('Unknown access level.');
    const g = grantsFor(preset, input.grants ?? k.grants, serverIds);
    if (by) assertCanGrant(by, g);
    k.preset = preset;
    k.grants = g;
  }
  if (input.expiresInDays !== undefined) {
    const days = Number(input.expiresInDays) || 0;
    if (days < 0 || days > 3650) throw new Error('Expiry must be 1-3650 days (or never).');
    k.expiresAt = days ? Date.now() + days * 86_400_000 : null;
  }
  writeJson(KEYS_FILE, keys);
  const { keyHash: _, ...pub } = k;
  return pub;
}

export function deleteApiKey(id: string, by: Principal | null = null): void {
  const keys = loadKeys();
  const k = keys.find((x) => x.id === id);
  if (!k) throw new Error('API key not found.');
  if (by && !by.owner) assertCanGrant(by, k.grants);
  writeJson(KEYS_FILE, keys.filter((x) => x.id !== id));
}

/**
 * 0.5.0: node links (the keys "Use this system as a node" makes) also carry storage, so a master panel can show and
 * manage Tavern Vault on its nodes. Links made before 0.5.0 get the storage permissions once; returns how many changed.
 */
export function upgradeNodeLinkKeys(): number {
  const keys = loadKeys();
  let changed = 0;
  for (const k of keys) {
    if (k.preset !== 'custom' || !/^Node link/.test(k.name)) continue;
    const before = k.grants.global.length;
    k.grants.global = [...new Set([...k.grants.global, 'storage.view', 'storage.manage'] as GlobalPerm[])];
    if (k.grants.global.length !== before) changed++;
  }
  if (changed) writeJson(KEYS_FILE, keys);
  return changed;
}

/** This system is someone's node: a node link key ("Use this system as a node") exists and a main panel has used it. */
export function usedAsNode(): boolean {
  return loadKeys().some((k) => /^Node link/.test(k.name) && !!k.lastUsed && (!k.expiresAt || k.expiresAt > Date.now()));
}

let lastUsedSaved = 0;

export function apiKeyPrincipal(key: string | undefined): Principal | null {
  // "th_" = Server Forge; "gsp_" keys were issued before the rename and still work.
  if (!key || !/^(th|gsp)_/.test(key)) return null;
  const keys = loadKeys();
  const hash = Buffer.from(sha256(key), 'hex');
  const match = keys.find((k) => {
    const stored = Buffer.from(k.keyHash, 'hex');
    return stored.length === hash.length && timingSafeEqual(stored, hash);
  });
  if (!match) return null;
  if (match.expiresAt && match.expiresAt < Date.now()) return null;
  // Record "last used" at most once a minute to avoid rewriting the file on every request.
  match.lastUsed = Date.now();
  if (Date.now() - lastUsedSaved > 60_000) {
    lastUsedSaved = Date.now();
    writeJson(KEYS_FILE, keys);
  }
  return { kind: 'apikey', id: match.id, name: `API key "${match.name}"`, owner: false, grants: match.grants };
}

// ---------- login rate limiting ----------

// Failed logins are counted per address and, for logins from other devices, per account too, so one account can't be
// guessed at from many addresses. The account limit is higher, and logins on this system itself never count towards it,
// so someone guessing from outside can't lock the owner out of their own system.
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_ACCOUNT_ATTEMPTS = 30;

const ipKey = (ip: string) => `ip:${ip}`;
const userKey = (username: string) => `user:${String(username ?? '').trim().toLowerCase()}`;

function failures(key: string): number {
  const a = attempts.get(key);
  return !a || Date.now() - a.first > WINDOW_MS ? 0 : a.count;
}

function count(key: string) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

// Old entries are dropped, so the list can't grow without end.
setInterval(() => {
  for (const [key, a] of attempts) if (Date.now() - a.first > WINDOW_MS) attempts.delete(key);
}, 5 * 60_000).unref();

/** `remote`: the login came over Remote access (from another device). */
export function loginAllowed(ip: string, username = '', remote = false): boolean {
  if (failures(ipKey(ip)) >= MAX_ATTEMPTS) return false;
  return !remote || !username || failures(userKey(username)) < MAX_ACCOUNT_ATTEMPTS;
}

export function recordLoginFailure(ip: string, username = '', remote = false): void {
  count(ipKey(ip));
  if (remote && username) count(userKey(username));
}

export function clearLoginFailures(ip: string, username = ''): void {
  attempts.delete(ipKey(ip));
  if (username) attempts.delete(userKey(username));
}
