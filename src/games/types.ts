// What every game module provides. The panel core (process control, console, API, UI shell) is game-agnostic;
// everything game-specific lives behind this interface. Valheim is the first module; Bedrock will be the second.
import type { StartOptions } from '../platform/process.ts';
import type { Job } from '../jobs.ts';

export type Settings = Record<string, string | number | boolean>;

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'folder' | 'select';
  help?: string;
  /** Heading this field is grouped under in Settings (shown once, above the first field of the group). */
  section?: string;
  /** Explanation shown under the heading (set on the group's first field). */
  sectionHelp?: string;
  /** For 'select'. */
  options?: { value: string; label: string; help?: string }[];
  /** For 'select': options come from the game's listVersions() for the value of another field (e.g. the flavor). */
  optionsFrom?: string;
  /** Changing it only takes effect after a restart. */
  restart?: boolean;
}

export interface ServerRecord {
  id: string;
  game: string;
  /** Name shown in the panel. */
  name: string;
  /** Folder with the game's server files. */
  installDir: string;
  settings: Settings;
  autoRestart: boolean;
  createdAt: number;
  /** Automatic backups: every `everyHours` (0 = off), keeping the newest `keep` automatic ones. */
  backupSchedule?: { everyHours: number; keep: number };
  /** Install new game versions by itself (Bedrock) instead of asking first. */
  autoUpdate?: boolean;
}

export interface Player {
  name: string;
  joinedAt: number | null;
  platformId?: string | null;
}

/** Live state a module extracts from the server's log. */
export interface LogState {
  /** true once the server reports it's ready for players. */
  ready: boolean;
  players: Player[];
  playerCount: number | null;
  version: string | null;
  lastSave: number | null;
  /** Anything else game-specific (e.g. Valheim's join code); shown on the overview. */
  extra: Record<string, string | number | null>;
}

export interface LogParser {
  feed(line: string): void;
  state(): LogState;
  /** Players ever seen (id -> name), e.g. for showing names next to IDs in access lists. */
  knownPlayers(): Record<string, string>;
}

export interface AccessList {
  id: string;
  label: string;
  help: string;
  /** What an entry is, for the add box placeholder (e.g. "Gamertag" or "XUID"). */
  entryLabel?: string;
}

export interface PropertyEntry {
  key: string;
  /** Current value in the file, or null if the key isn't in the file (the game uses its default). */
  value: string | null;
  defaultValue: string | null;
  description: string;
  type: 'boolean' | 'number' | 'select' | 'text';
  options?: string[];
  /** false = the game doesn't use this key (e.g. Java keys left in a Bedrock file). */
  known: boolean;
  optional: boolean;
  /** Friendly name; the key is then shown small underneath it. */
  label?: string;
  /** Heading it's listed under. */
  section?: string;
  /** Hidden until "Show advanced" is on, or a search matches. */
  advanced?: boolean;
}

export interface ConsoleIO {
  command(cmd: string): Promise<void>;
  waitForLine(pattern: RegExp, timeoutMs: number, following?: number): Promise<string[]>;
  flush(): void;
}

export interface BackupSupport {
  /** Folder the backup is relative to, and the files/folders (relative to it) to include. */
  sources(record: ServerRecord): { base: string; include: string[]; world: string | null };
  /**
   * For games that can freeze saving while running (Bedrock's save hold/query/resume): returns the exact files and
   * lengths to copy, and a function to call when copying is done.
   */
  hot?(record: ServerRecord, io: ConsoleIO): Promise<{ files: { rel: string; length: number }[]; finish(): Promise<void> }>;
  /** Turns saving back on after a live backup that was cut off (Server Forge closed in the middle of it). */
  resume?(io: ConsoleIO): Promise<void>;
}

export interface AddonSupport {
  /** For games where only some servers have one (Java: mods for Fabric/Forge/NeoForge, plugins for Paper/Spigot). */
  available?(record: ServerRecord): boolean;
  /** Wording for the tab: "Addons", "Mods" or "Plugins". */
  labels?(record: ServerRecord): { tab: string; noun: string; plural: string; dropHelp: string };
  list(record: ServerRecord): unknown[];
  /** `identity`: what the file is when its name doesn't say (e.g. a Nexus Mods download). */
  install(record: ServerRecord, file: string, source: string | null, identity?: { namespace: string; name: string; version: string }): Promise<{ installed: unknown[]; warnings: string[] }>;
  remove(record: ServerRecord, id: string): void;
  setEnabled(record: ServerRecord, id: string, enabled: boolean): void;
  /** A file path, or the image itself (icons inside .jar files). */
  icon(record: ServerRecord, id: string): string | Buffer | null;
  /** CurseForge game slug for browsing (needs the owner's CurseForge API key). */
  curseforgeGame?: string;
  /** Sites people get addons from, opened in the addon browser. */
  links?: { label: string; url: string; help?: string }[] | ((record: ServerRecord) => { label: string; url: string; help?: string }[]);
  /** File types the upload box accepts. */
  accept: string;
  /** Listed only: another tool manages them (Satisfactory: Satisfactory Mod Manager). No upload box or buttons. */
  readOnly?: boolean;
  /** Adds an item by ID or link instead of a file (Space Engineers: Steam Workshop). Shows an input box on the Mods tab. */
  addById?(record: ServerRecord, input: string): Promise<{ installed: unknown[]; warnings: string[] }>;
  /** Placeholder for that input box (default: a Steam Workshop link). */
  addByIdPlaceholder?: string;
  /** `install` also accepts a folder (Bedrock: unpacked behavior/resource packs can be dropped as folders). */
  folders?: boolean;
  /** Changes need the server stopped (Valheim: loaded mod DLLs are locked while it runs). */
  needsStopped?: boolean;
  /** A status line at the top (Valheim: is BepInEx installed?) with an optional one-click setup. */
  status?(record: ServerRecord): { ok: boolean; title: string; text: string; setupLabel?: string; confirm?: string } | null;
  /** Games where modding must be switched on first (Valheim). false = vanilla: nothing can be installed yet. */
  isOn?(record: ServerRecord): boolean;
  setup?(record: ServerRecord, log: (line: string) => void): Promise<string>;
  /** Per-item "who needs it" choice (Valheim: server + players / server only / players only). */
  sides?: { value: string; label: string }[];
  setSide?(record: ServerRecord, id: string, side: string): void;
  /** A built-in search (Endstone plugins: GitHub + PyPI); results are installed with installFound(id). */
  search?(record: ServerRecord, query: string): Promise<{ results: { id: string; name: string; summary: string; author: string | null; url: string; source: string; stars?: number; version?: string }[]; errors: string[] }>;
  installFound?(record: ServerRecord, id: string): Promise<{ installed: unknown[]; warnings: string[] }>;
  /** Newer versions available: id -> version. */
  checkUpdates?(record: ServerRecord): Promise<Record<string, string>>;
  update?(record: ServerRecord, id: string): Promise<{ installed: unknown[]; warnings: string[] }>;
  /**
   * Games where the load order of active items matters (Bedrock: the order of world_behavior_packs.json /
   * world_resource_packs.json; the top wins). `type` picks the list; `ids` are the active items in the new order.
   */
  reorder?(record: ServerRecord, type: string, ids: string[]): void;
  /**
   * Mod settings files (Valheim: BepInEx/config/*.cfg), edited from the Mods tab. `mod` ties a file to an installed item
   * (its id) so the item gets a Settings button. Settings marked `shared` are sent to players through the share link.
   */
  settings?: {
    list(record: ServerRecord): { file: string; plugin: string | null; version: string | null; mod: string | null; settings: number; shared: number }[];
    read(record: ServerRecord, file: string): unknown;
    write(
      record: ServerRecord,
      file: string,
      values: { section: string; key: string; value: string }[],
      shared: { section: string; key: string }[],
    ): { changed: number; shared: number; sharedBefore: number };
  };
  /** Games that can keep addons in more than one place (Bedrock: server folder or world folder). */
  locations?: {
    options: { value: string; label: string; help: string }[];
    /** Where new addons are installed. */
    get(record: ServerRecord): string;
    set(record: ServerRecord, location: string): void;
    move(record: ServerRecord, id: string, to: string): void;
    /** Folder paths for each location, for display. */
    describe(record: ServerRecord): Record<string, string>;
  };
}

export interface PropertiesSupport {
  read(record: ServerRecord): { file: string; entries: PropertyEntry[]; problems: string[] };
  write(record: ServerRecord, values: Record<string, string>): void;
  /** Rebuilds the file from the official template, keeping current values; returns a note about what changed. */
  repair?(record: ServerRecord): string;
}

export interface ChatRelayStatus {
  /** The relay pack is installed and switched on in the world. */
  on: boolean;
  /** Scripting module version the pack asks for (e.g. "2.11.0-beta"). */
  moduleVersion: string | null;
  /** What Server Forge would use if switched on now (read from the beta packs already on this server). */
  suggestedVersion: string;
  /** Where that suggestion came from. */
  suggestedFrom: string;
  /** The world's "Beta APIs" experiment (the chat event needs it); null if unknown. */
  betaApis: boolean | null;
  /** server.properties prints script output to the console (content-log-console-output-enabled); the relay needs it. */
  contentLog: boolean;
  /** The installed pack is from an older Server Forge (missing newer features such as mute). */
  outdated: boolean;
}

export interface GameModule {
  id: string;
  name: string;
  fields: SettingField[];
  defaults(record: Pick<ServerRecord, 'installDir'>): Settings;
  /** Throws a readable Error if settings are invalid; returns them normalized. */
  validate(settings: Settings): Settings;
  /** Checks the install folder looks right for this game; throws otherwise. */
  checkInstall(installDir: string): void;
  /** For Import: settings worked out from an existing server folder (e.g. which jar and Java version). */
  detect?(installDir: string): Settings;
  /**
   * For Import, before the folder is checked: may point at the real server folder (Endstone: the bedrock_server folder
   * inside the one chosen) and bring things in (Endstone: plugins pip-installed into the old Python). `notes` are shown
   * to whoever imported it.
   */
  prepareImport?(installDir: string): Promise<{ installDir: string; notes: string[] }>;
  launch(record: ServerRecord, logFile: string): StartOptions;
  /** Executable name, used to make sure a saved PID still belongs to this server. */
  processName: string;
  /**
   * Games that read typed commands (Minecraft). The server then runs under the runner (runner.ts), commands can be
   * sent from the Console tab, and Stop sends `stop` so the world saves.
   */
  commands?: {
    stop: string | ((record: ServerRecord) => string);
    /** Sent before the stop command, waiting (up to timeoutMs) for a log line matching `done` (Factorio: /server-save). */
    saveFirst?: { command: string; done: RegExp; timeoutMs: number };
  };
  /** Console commands keep a leading "/" (Factorio: commands start with "/", anything else is chat). */
  slashCommands?: boolean;
  /** Runs under the runner only to capture its console output into the log (no typed commands; Palworld). */
  captureOutput?: boolean;
  /** The console command that messages everyone (countdown warnings), for games with typed commands. Default: "say <text>". */
  announceCommand?(text: string): string;
  /**
   * Console commands for the Players tab's actions (kick, ban, pardon, op, deop, whitelist-add, whitelist-remove).
   * Only the actions listed are offered. `reason` may be empty.
   */
  playerCommands?: Partial<Record<'kick' | 'ban' | 'pardon' | 'op' | 'deop' | 'whitelist-add' | 'whitelist-remove', (name: string, reason: string) => string>>;
  /**
   * Games that only read commands typed into a real console window (Terraria / tModLoader ignore piped input). The
   * server runs in its own hidden console and Server Forge types commands into it; Stop types `stop`.
   */
  consoleCommands?: { stop: string };
  /** The game's own log file, read for the Console tab instead of Server Forge's (games whose output can't be captured). */
  gameLog?(record: ServerRecord): string;
  /** Lines to leave out of the Console tab (e.g. hundreds of world-generation progress lines). Still read by the parser. */
  hideLine?(line: string): boolean;
  /** Games with their own server API (Satisfactory): console commands go through it; the answer is shown in the console. */
  runCommand?(record: ServerRecord, command: string): Promise<string | void>;
  /** A clean stop the game's own way (Satisfactory: save, then the API's Shutdown). true = asked; false = fall back to Ctrl+C. */
  gracefulStop?(record: ServerRecord, note: (message: string) => void): Promise<boolean>;
  /** A message to everyone in the game, the game's own way (Space Engineers: Remote API chat). Used for countdown warnings. */
  say?(record: ServerRecord, text: string): Promise<void>;
  /** Runs once each time the server becomes ready (Satisfactory: claim it, create the first game, apply settings). */
  onReady?(record: ServerRecord, note: (message: string) => void): Promise<void>;
  /** Runs before every start (e.g. download the Java runtime if it's missing). `note` writes to the console. */
  prepare?(record: ServerRecord, note: (message: string) => void): Promise<void>;
  /** Versions for a 'select' field with optionsFrom (e.g. Minecraft versions for a server type). */
  listVersions?(from: string): Promise<string[]>;
  /** Settings file editor (Minecraft's server.properties). */
  properties?: PropertiesSupport;
  /** Name of the tab for that editor. Default: "Properties". */
  propertiesLabel?: string;
  /** What to back up (and how to do it safely while running). */
  backup?: BackupSupport;
  /** Addon/mod/plugin manager. */
  addons?: AddonSupport;
  /**
   * A second manager with its own tab, for servers that take two kinds (Bedrock on Endstone: addons and plugins).
   * Served at /api/servers/:id/plugins/... with the same routes as /addons.
   */
  plugins?: AddonSupport;
  /** Crash checker: reads the logs since `since` and explains what went wrong. */
  diagnose?(record: ServerRecord, logFile: string, since: number): unknown;
  /** The port players connect to (shown with the system's IP at the top of the server page), and the player limit. */
  connection?(record: ServerRecord): { port: number | null; protocol: 'TCP' | 'UDP'; maxPlayers?: number | null };
  /**
   * How much RAM the server may use, for the usage display. Games without a memory setting (Bedrock, Valheim) leave this
   * out and are shown against the system's total RAM.
   */
  memoryLimit?(record: ServerRecord): { mb: number; label: string; note: string } | null;
  /** World options that normally need the game (Bedrock: experiments, cheats). Written only while stopped. */
  world?: {
    read(record: ServerRecord): unknown;
    write(
      record: ServerRecord,
      changes: { cheats?: boolean; experiments?: Record<string, boolean>; cheatSettings?: Record<string, boolean | number | string>; force?: boolean },
    ): string[];
  };
  /**
   * In-game chat (Bedrock: vanilla servers don't log chat, so a small script pack made by Server Forge writes each
   * message to the console as a tagged line). `sayCommand` turns a message from the panel into a console command.
   */
  chat?: {
    status(record: ServerRecord): ChatRelayStatus;
    setRelay(record: ServerRecord, on: boolean, moduleVersion?: string): Promise<ChatRelayStatus>;
    sayCommand(text: string): string;
  };
  /** Minecraft-style games require accepting the EULA before a new server is created. */
  eula?: { label: string; url: string };
  /** Fields shown when creating a new server (defaults to quickFields picked from `fields`). */
  newFields?: SettingField[];
  createParser(): LogParser;
  /** Optional independent readiness check when console output is missing or delayed. */
  probeReady?(record: ServerRecord): Promise<boolean>;
  /** Extra info for the overview that isn't in the log (e.g. Valheim bosses from the world save). */
  details?(record: ServerRecord): Promise<Record<string, unknown>>;
  /**
   * Downloads/installs (or updates) the server software into record.installDir. Present on games Server Forge can set
   * up from scratch; also used for the "Update server software" button. `force` reinstalls the latest version even when
   * the installed one looks current.
   */
  install?(record: ServerRecord, job: Job, opts?: { force?: boolean }): Promise<void>;
  /** Setting keys to ask for when creating a brand-new server (the rest use defaults). */
  quickFields?: string[];
  accessLists?: AccessList[];
  readAccessList?(record: ServerRecord, list: string): string[];
  /**
   * Saves a list. Returns console commands to run afterwards if the server is running (e.g. "allowlist reload").
   * `running` lets games apply changes through the console instead of the file while the server is up.
   */
  writeAccessList?(record: ServerRecord, list: string, entries: string[], running: boolean): string[] | void | Promise<string[] | void>;
}
