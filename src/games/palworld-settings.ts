// Every world setting in PalWorldSettings.ini, for Palworld's World settings tab: friendly names, what each one does
// (from Pocketpair's documentation, https://docs.palworldgame.com/settings-and-operation/configuration/), and the limits
// Pocketpair documents. Settings the game adds later still show up, listed under "Other" (see palworldProperties).

export type PalSettingType = 'rate' | 'decimal' | 'int' | 'bool' | 'text' | 'select' | 'list';

export interface PalSetting {
  key: string;
  label: string;
  desc: string;
  type: PalSettingType;
  section: string;
  /** Hidden until "Show advanced" is on, or a search matches. */
  advanced?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

const WORLD = 'World rules';
const TIME = 'Time and rates';
const PALS = 'Pals';
const PLAYERS = 'Players';
const BASES = 'Bases and building';
const ITEMS = 'Items and gathering';
const DEATH = 'Death and respawning';
const STATS = 'Stat points';
const GUILDS = 'Guilds';
const PVP = 'PvP';
const VOICE = 'Voice and chat';
const NET = 'Connections';
const PERF = 'Performance';

const rate = (key: string, label: string, desc: string, section: string, extra: Partial<PalSetting> = {}): PalSetting => ({ key, label, desc, section, type: 'rate', min: 0, ...extra });
const bool = (key: string, label: string, desc: string, section: string, extra: Partial<PalSetting> = {}): PalSetting => ({ key, label, desc, section, type: 'bool', ...extra });
const int = (key: string, label: string, desc: string, section: string, extra: Partial<PalSetting> = {}): PalSetting => ({ key, label, desc, section, type: 'int', ...extra });
const dec = (key: string, label: string, desc: string, section: string, extra: Partial<PalSetting> = {}): PalSetting => ({ key, label, desc, section, type: 'decimal', min: 0, ...extra });
const text = (key: string, label: string, desc: string, section: string, extra: Partial<PalSetting> = {}): PalSetting => ({ key, label, desc, section, type: 'text', ...extra });
const undocumented = 'Pocketpair doesn\'t document this one.';

export const PAL_SETTINGS: PalSetting[] = [
  // ----- World rules -----
  { key: 'Difficulty', label: 'Difficulty preset', desc: 'None = Normal, using the rates below. Casual and Hard are the game\'s presets.', type: 'select', options: ['None', 'Casual', 'Hard'], section: WORLD },
  bool('bHardcore', 'Hardcore', 'Players can\'t respawn after dying.', WORLD),
  bool('bCharacterRecreateInHardcore', 'Recreate character in Hardcore', 'Lets a player make a new character after dying in Hardcore.', WORLD),
  bool('bPalLost', 'Lose Pals permanently', 'Pals are lost for good when they die.', WORLD),
  bool('bEnableInvaderEnemy', 'Base raids', 'Enemies can invade bases.', WORLD),
  bool('EnablePredatorBossPal', 'Predator Pals', 'Predator boss Pals can appear.', WORLD),
  bool('bAllowEnemyCampSpawnNearBaseCamp', 'Enemy camps near bases', 'Enemy camps can spawn close to player bases.', WORLD),
  bool('bEnableFastTravel', 'Fast travel', 'Players can fast travel.', WORLD),
  bool('bEnableFastTravelOnlyBaseCamp', 'Fast travel between bases only', 'Fast travel only works between bases.', WORLD),
  bool('bIsStartLocationSelectByMap', 'Choose start location', 'New players pick where they start on the map.', WORLD),
  bool('bExistPlayerAfterLogout', 'Sleep where you log out', 'A player\'s character stays in the world, asleep, after they log out.', WORLD),
  { key: 'RandomizerType', label: 'Pal randomizer', desc: 'Randomizes which Pals spawn. None, Region or All.', type: 'select', options: ['None', 'Region', 'All'], section: WORLD },
  text('RandomizerSeed', 'Randomizer seed', 'Seed used when the Pal randomizer is on.', WORLD),
  bool('bIsRandomizerPalLevelRandom', 'Random wild Pal levels', 'Wild Pal levels are fully random.', WORLD),
  int('SupplyDropSpan', 'Meteorite and supply drop interval (minutes)', 'Minutes between meteorite and supply drops.', WORLD, { min: 0 }),
  { key: 'DenyTechnologyList', label: 'Disabled technologies', desc: 'Technology IDs players can\'t unlock, written as (ID1,ID2). Empty = none disabled.', type: 'list', section: WORLD, advanced: true },

  // ----- Time and rates -----
  rate('DayTimeSpeedRate', 'Daytime speed', 'How fast daytime passes. 1 = normal.', TIME),
  rate('NightTimeSpeedRate', 'Night speed', 'How fast night passes. 1 = normal.', TIME),
  rate('ExpRate', 'XP rate', 'XP gain multiplier. 1 = normal.', TIME),
  rate('WorkSpeedRate', 'Pal work speed', 'How fast Pals work at bases. 1 = normal. ' + undocumented, TIME),
  rate('MonsterFarmActionSpeedRate', 'Ranch production speed', 'How fast grazing Pals produce items. 1 = normal.', TIME),
  dec('PalEggDefaultHatchingTime', 'Egg hatching time (hours)', 'Hours for a Huge Egg to hatch.', TIME),
  rate('FishingDifficultyRate', 'Fishing difficulty', 'From 0.1 to 1.', TIME, { min: 0.1, max: 1 }),

  // ----- Pals -----
  rate('PalCaptureRate', 'Capture rate', 'Capture chance multiplier. 1 = normal.', PALS),
  rate('PalSpawnNumRate', 'Pal spawn rate', 'How many Pals spawn. Higher values cost server performance.', PALS),
  rate('PalDamageRateAttack', 'Damage dealt by Pals', '1 = normal.', PALS),
  rate('PalDamageRateDefense', 'Damage taken by Pals', '1 = normal.', PALS),
  rate('PalStomachDecreaceRate', 'Pal hunger rate', 'How fast Pals get hungry. 1 = normal.', PALS),
  rate('PalStaminaDecreaceRate', 'Pal stamina use', 'How fast Pals use stamina. 1 = normal.', PALS),
  rate('PalAutoHPRegeneRate', 'Pal health regeneration', 'Natural health regeneration. 1 = normal.', PALS),
  rate('PalAutoHpRegeneRateInSleep', 'Pal health regeneration in the Palbox', 'Health regeneration while sleeping in the Palbox. 1 = normal.', PALS),

  // ----- Players -----
  rate('PlayerDamageRateAttack', 'Damage dealt by players', '1 = normal.', PLAYERS),
  rate('PlayerDamageRateDefense', 'Damage taken by players', '1 = normal.', PLAYERS),
  rate('PlayerStomachDecreaceRate', 'Player hunger rate', 'How fast players get hungry. 1 = normal.', PLAYERS),
  rate('PlayerStaminaDecreaceRate', 'Player stamina use', 'How fast players use stamina. 1 = normal.', PLAYERS),
  rate('PlayerAutoHPRegeneRate', 'Player health regeneration', 'Natural health regeneration. 1 = normal.', PLAYERS),
  rate('PlayerAutoHpRegeneRateInSleep', 'Player health regeneration asleep', 'Health regeneration while sleeping. 1 = normal.', PLAYERS),

  // ----- Bases and building -----
  int('BaseCampMaxNum', 'Bases on the server', 'Total bases allowed across the whole server.', BASES, { min: 1 }),
  int('BaseCampMaxNumInGuild', 'Bases per guild', 'From 1 to 10.', BASES, { min: 1, max: 10 }),
  int('BaseCampWorkerMaxNum', 'Pals per base', 'Up to 50.', BASES, { min: 1, max: 50 }),
  rate('BuildObjectHpRate', 'Building health', '1 = normal. ' + undocumented, BASES),
  rate('BuildObjectDamageRate', 'Damage to buildings', '1 = normal.', BASES),
  rate('BuildObjectDeteriorationDamageRate', 'Building decay speed', '1 = normal.', BASES),
  bool('bBuildAreaLimit', 'Limit building near landmarks', 'Stops players building near structures such as fast travel points.', BASES),
  int('MaxBuildingLimitNum', 'Building limit per player', '0 = no limit.', BASES, { min: 0 }),
  int('MaxBuildingLimitNumPerPlayer', 'Building limit per player (second setting)', '0 = no limit. ' + undocumented, BASES, { min: 0, advanced: true }),
  bool('bInvisibleOtherGuildBaseCampAreaFX', 'Other guilds\' base boundaries', 'Pocketpair describes this as showing base area boundaries; the name suggests it hides other guilds\' boundaries.', BASES),
  bool('bEnableBuildingPlayerUIdDisplay', 'Show who built structures', 'Shows the creator\'s player ID on structures.', BASES),
  int('BuildingNameDisplayCacheTTLSeconds', 'Builder name cache (seconds)', undocumented, BASES, { min: 0, advanced: true }),

  // ----- Items and gathering -----
  rate('CollectionDropRate', 'Gathering yield', 'Multiplier for items from gathering. 1 = normal.', ITEMS),
  rate('CollectionObjectHpRate', 'Gatherable object health', 'Health of trees, rocks and so on. 1 = normal.', ITEMS),
  rate('CollectionObjectRespawnSpeedRate', 'Gatherable respawn interval', 'Respawn interval multiplier. 1 = normal.', ITEMS),
  rate('EnemyDropItemRate', 'Enemy item drops', 'Multiplier for items dropped by enemies. 1 = normal.', ITEMS),
  rate('ItemWeightRate', 'Item weight', '1 = normal.', ITEMS),
  rate('ItemCorruptionMultiplier', 'Item spoilage speed', '1 = normal.', ITEMS),
  rate('EquipmentDurabilityDamageRate', 'Equipment durability loss', '1 = normal.', ITEMS),
  int('DropItemMaxNum', 'Dropped items in the world', 'Most dropped items allowed at once.', ITEMS, { min: 0 }),
  dec('DropItemAliveMaxHours', 'Dropped items last (hours)', 'How long dropped items stay in the world.', ITEMS),
  int('DropItemMaxNum_UNKO', 'Dropped droppings in the world', undocumented, ITEMS, { min: 0, advanced: true }),
  bool('bActiveUNKO', 'Pal droppings', undocumented, ITEMS, { advanced: true }),

  // ----- Death and respawning -----
  { key: 'DeathPenalty', label: 'On death', desc: 'None = keep everything. Item = drop items, not equipment. ItemAndEquipment = drop both. All = drop everything, including Pals in the party.', type: 'select', options: ['None', 'Item', 'ItemAndEquipment', 'All'], section: DEATH },
  dec('BlockRespawnTime', 'Respawn cooldown (seconds)', 'Wait before you can respawn after dying.', DEATH),
  dec('RespawnPenaltyDurationThreshold', 'Quick-death threshold (seconds)', 'Dying sooner than this after respawning makes the cooldown longer.', DEATH),
  dec('RespawnPenaltyTimeScale', 'Quick-death cooldown multiplier', 'How much longer the respawn cooldown gets.', DEATH),
  bool('bEnableNonLoginPenalty', 'Offline penalty', undocumented, DEATH, { advanced: true }),

  // ----- Stat points -----
  bool('bAllowEnhanceStat_Health', 'Allow points in Health', 'Players can spend stat points here.', STATS),
  bool('bAllowEnhanceStat_Attack', 'Allow points in Attack', 'Players can spend stat points here.', STATS),
  bool('bAllowEnhanceStat_Stamina', 'Allow points in Stamina', 'Players can spend stat points here.', STATS),
  bool('bAllowEnhanceStat_Weight', 'Allow points in Carry Weight', 'Players can spend stat points here.', STATS),
  bool('bAllowEnhanceStat_WorkSpeed', 'Allow points in Work Speed', 'Players can spend stat points here.', STATS),

  // ----- Guilds -----
  int('GuildPlayerMaxNum', 'Players per guild', 'Most players in one guild.', GUILDS, { min: 1 }),
  int('GuildRejoinCooldownMinutes', 'Guild rejoin cooldown (minutes)', 'Wait before rejoining a guild.', GUILDS, { min: 0 }),
  bool('bAutoResetGuildNoOnlinePlayers', 'Delete inactive guilds\' structures', 'If no guild members log in for the time below, their structures are deleted.', GUILDS),
  dec('AutoResetGuildTimeNoOnlinePlayers', 'Inactive guild time (hours)', 'How long a guild must be offline before the setting above applies.', GUILDS),
  dec('AutoTransferMasterCheckIntervalSeconds', 'Guild master check interval (seconds)', undocumented, GUILDS, { advanced: true }),
  int('AutoTransferMasterThresholdDays', 'Inactive guild master (days)', undocumented, GUILDS, { min: 0, advanced: true }),
  int('MaxGuildsPerFrame', 'Guilds processed per frame', undocumented, GUILDS, { min: 1, advanced: true }),

  // ----- PvP -----
  bool('bIsPvP', 'PvP', 'Turns on PvP. Turn on "Players can damage each other" below too.', PVP),
  bool('bEnablePlayerToPlayerDamage', 'Players can damage each other', undocumented, PVP),
  bool('bEnableFriendlyFire', 'Friendly fire', undocumented, PVP),
  bool('bCanPickupOtherGuildDeathPenaltyDrop', 'Loot other guilds\' death drops', undocumented, PVP),
  bool('bEnableDefenseOtherGuildPlayer', 'Base defenses hit other guilds', undocumented, PVP),
  bool('bDisplayPvPItemNumOnWorldMap_BaseCamp', 'Show PvP items in bases on the map', 'Shows PvP-only items held at each base.', PVP),
  bool('bDisplayPvPItemNumOnWorldMap_Player', 'Show players and PvP items on the map', 'Shows player locations and the PvP items they carry.', PVP),
  bool('bAdditionalDropItemWhenPlayerKillingInPvPMode', 'Drop an item on PvP kills', 'A killed player drops the item below.', PVP),
  text('AdditionalDropItemWhenPlayerKillingInPvPMode', 'PvP kill item ID', 'ID of the item dropped on a PvP kill.', PVP),
  int('AdditionalDropItemNumWhenPlayerKillingInPvPMode', 'PvP kill item amount', 'How many of that item drop.', PVP, { min: 0 }),

  // ----- Voice and chat -----
  bool('bEnableVoiceChat', 'Voice chat', 'Turns on in-game voice chat.', VOICE),
  dec('VoiceChatMaxVolumeDistance', 'Full volume distance', 'Voice stays at full volume up to this distance.', VOICE),
  dec('VoiceChatZeroVolumeDistance', 'Silent distance', 'Voice can\'t be heard beyond this distance.', VOICE),
  int('ChatPostLimitPerMinute', 'Chat messages per minute', 'Most messages a player can send per minute.', VOICE, { min: 0 }),

  // ----- Connections -----
  bool('bAllowClientMod', 'Allow modded players', 'Players with mods on can join. Turning it off locks out anyone using SF Mod Manager mods.', NET),
  { key: 'CrossplayPlatforms', label: 'Allowed platforms', desc: 'Platforms that can join, written as (Steam,Xbox,PS5,Mac).', type: 'list', section: NET },
  bool('bUseAuth', 'Check player accounts', undocumented, NET, { advanced: true }),
  text('BanListURL', 'Ban list address', undocumented, NET, { advanced: true }),
  text('PublicIP', 'Public IP (community servers)', 'Your external IP, if a community server detects the wrong one.', NET, { advanced: true }),
  text('Region', 'Region', undocumented, NET, { advanced: true }),
  bool('bAllowGlobalPalboxExport', 'Save to Global Palbox', 'Players can save Pals to the Global Palbox.', NET),
  bool('bAllowGlobalPalboxImport', 'Load from Global Palbox', 'Players can bring Pals in from the Global Palbox.', NET),
  bool('RCONEnabled', 'RCON', 'Turns on remote console access.', NET, { advanced: true }),
  int('RCONPort', 'RCON port', 'Port used for RCON.', NET, { min: 1, max: 65535, advanced: true }),
  bool('bEnableAimAssistPad', 'Aim assist for controllers', undocumented, NET, { advanced: true }),
  bool('bEnableAimAssistKeyboard', 'Aim assist for keyboards', undocumented, NET, { advanced: true }),
  bool('bIsMultiplay', 'Multiplayer flag', undocumented, NET, { advanced: true }),
  int('CoopPlayerMaxNum', 'Co-op player limit', undocumented, NET, { min: 1, advanced: true }),

  // ----- Performance -----
  dec('AutoSaveSpan', 'Auto-save interval (seconds)', 'How often the world saves.', PERF),
  bool('bIsUseBackupSaveData', 'World backups', 'The game keeps its own world backups. Uses more disk.', PERF),
  dec('ServerReplicatePawnCullDistance', 'Pal sync distance (cm)', 'How far from a player Pals are kept in sync. From 5000 to 15000.', PERF, { min: 5000, max: 15000 }),
  int('PhysicsActiveDropItemMaxNum', 'Dropped items using physics', '-1 = no limit.', PERF, { min: -1 }),
  dec('ItemContainerForceMarkDirtyInterval', 'Container re-sync interval (seconds)', 'How often an open container is forced to re-sync.', PERF, { advanced: true }),
  dec('PlayerDataPalStorageUpdateCheckTickInterval', 'Pal storage check interval', undocumented, PERF, { advanced: true }),
];

/** Set on the Settings tab, or by Server Forge itself: changing them here would be overwritten at the next start. */
export const PAL_MANAGED = new Set([
  'ServerName',
  'ServerDescription',
  'AdminPassword',
  'ServerPassword',
  'PublicPort',
  'ServerPlayerMaxNum',
  'RESTAPIEnabled',
  'RESTAPIPort',
  'bShowPlayerList',
  'LogFormatType',
  'bIsShowJoinLeftMessage',
]);
