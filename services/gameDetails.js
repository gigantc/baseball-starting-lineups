// Builds per-game detail JSON files consumed by the GameDetail modal in
// mlb-lineup-site. Two passes:
//   1. buildSkeletonForGame() — runs at 4:30am with fetchMLBGames. Pre-game
//      data: venue, weather, broadcasts, umpires, pitcher cards w/ arsenal,
//      team records, division standing. Lineup arrays empty.
//   2. enrichDetailWithLineups() — runs from pollLineups when boxscore yields
//      a lineup. Adds batter rows w/ season stats and career BvP vs opposing
//      probable pitcher.
//
// Output: SITE_DATA_DIR/details/{gamePk}.json (and a mirrored copy under
// ../mlb-lineup-site/public/data/details/ when running locally).

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const SITE_DATA_DIR = process.env.SITE_DATA_DIR
  ? path.resolve(process.env.SITE_DATA_DIR)
  : path.resolve('./site-data');
const DETAILS_DIR = path.resolve(SITE_DATA_DIR, 'details');
const LOCAL_DETAILS_DIR = path.resolve('../mlb-lineup-site/public/data/details');
const BVP_CACHE_FILE = path.resolve('./bvp-cache.json');

const STATS = 'https://statsapi.mlb.com/api/v1';
const STATS_V11 = 'https://statsapi.mlb.com/api/v1.1';

const DIVISION_NAMES = {
  200: 'AL West',
  201: 'AL East',
  202: 'AL Central',
  203: 'NL West',
  204: 'NL East',
  205: 'NL Central',
};

const OFFICIAL_ABBR = {
  'Home Plate': 'HP',
  'First Base': '1B',
  'Second Base': '2B',
  'Third Base': '3B',
};

// In-memory caches reset each script start; BvP also persisted to disk.
const standingsCache = new Map();   // season -> response
const arsenalCache = new Map();     // `${id}-${season}` -> arsenal[]
const bvpCache = new Map();         // `${batter}-${pitcher}` -> bvp | null

// ---------- utilities ----------

const writeJsonAtomic = (filePath, payload) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
};

const readJsonSafe = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const num = (v, fallback = 0) => {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const ord = (rank) => {
  const n = parseInt(rank, 10);
  if (!Number.isFinite(n)) return rank;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
};

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

// ---------- BvP cache persistence ----------

export const loadBvpCache = () => {
  const data = readJsonSafe(BVP_CACHE_FILE);
  if (!data || typeof data !== 'object') return;
  for (const [k, v] of Object.entries(data)) {
    bvpCache.set(k, v);
  }
};

const persistBvpCache = () => {
  const obj = Object.fromEntries(bvpCache);
  writeJsonAtomic(BVP_CACHE_FILE, obj);
};

// ---------- detail file paths ----------

const detailPaths = (gamePk) => {
  const primary = path.resolve(DETAILS_DIR, `${gamePk}.json`);
  const mirror = !process.env.SITE_DATA_DIR
    ? path.resolve(LOCAL_DETAILS_DIR, `${gamePk}.json`)
    : null;
  return { primary, mirror };
};

const writeDetailFile = (gamePk, detail) => {
  const { primary, mirror } = detailPaths(gamePk);
  writeJsonAtomic(primary, detail);
  if (mirror) writeJsonAtomic(mirror, detail);
};

const readDetailFile = (gamePk) => {
  const { primary } = detailPaths(gamePk);
  return readJsonSafe(primary);
};

// ---------- API response adapters ----------

const pitchArsenalFromResponse = (resp) => {
  const splits = resp?.stats?.[0]?.splits || [];
  return splits
    .map((s) => ({
      code: s.stat?.type?.code,
      name: s.stat?.type?.description,
      pct: s.stat?.percentage,
      mph: s.stat?.averageSpeed,
    }))
    .filter((p) => p.pct != null)
    .sort((a, b) => b.pct - a.pct);
};

const bvpFromResponse = (resp) => {
  const total = resp?.stats?.find((s) => s.type?.displayName === 'vsPlayerTotal');
  const split = total?.splits?.[0];
  if (!split) return null;
  const s = split.stat;
  if (!s) return null;
  if ((s.atBats == null || s.atBats === 0) && !s.plateAppearances) return null;
  return {
    ab: num(s.atBats),
    hr: num(s.homeRuns),
    rbi: num(s.rbi),
    avg: s.avg || '.000',
    ops: s.ops || '.000',
  };
};

const teamStanding = (standings, teamId) => {
  if (!standings?.records) return '';
  for (const div of standings.records) {
    const rec = div.teamRecords?.find((t) => t.team?.id === teamId);
    if (!rec) continue;
    const divName = DIVISION_NAMES[div.division?.id] || '';
    return `${ord(rec.divisionRank)} ${divName}`.trim();
  }
  return '';
};

// MLB moved broadcast info from /game/{pk}/content?epg out of population
// for current games; the live source is now /schedule?hydrate=broadcasts.
// Each item has homeAway + type + name + callSign + isNational + language.
const buildBroadcasts = (scheduleEntry) => {
  const tv = [];
  const radio = [];
  for (const b of scheduleEntry?.broadcasts || []) {
    if (b.language && b.language !== 'en') continue;
    const side = b.homeAway === 'home' ? 'home' : b.homeAway === 'away' ? 'away' : null;
    if (!side) continue;
    const name = (b.name || b.callSign || '').trim();
    if (!name) continue;
    if (b.type === 'TV') {
      tv.push({ team: side, name });
    } else if (b.type === 'AM' || b.type === 'FM' || b.type === 'Audio') {
      radio.push({ team: side, name });
    }
  }
  return { tv, radio };
};

// ---------- fetch helpers with cache ----------

const getStandings = async (season) => {
  if (standingsCache.has(season)) return standingsCache.get(season);
  try {
    const r = await fetchJson(`${STATS}/standings?leagueId=103,104&season=${season}`);
    standingsCache.set(season, r);
    return r;
  } catch {
    return null;
  }
};

const getArsenal = async (playerId, season) => {
  const key = `${playerId}-${season}`;
  if (arsenalCache.has(key)) return arsenalCache.get(key);
  try {
    const r = await fetchJson(
      `${STATS}/people/${playerId}/stats?stats=pitchArsenal&group=pitching&season=${season}&sportId=1`,
    );
    const arsenal = pitchArsenalFromResponse(r);
    arsenalCache.set(key, arsenal);
    return arsenal;
  } catch {
    return [];
  }
};

const getBvP = async (batterId, pitcherId) => {
  const key = `${batterId}-${pitcherId}`;
  if (bvpCache.has(key)) return bvpCache.get(key);
  try {
    const r = await fetchJson(
      `${STATS}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`,
    );
    const bvp = bvpFromResponse(r);
    bvpCache.set(key, bvp);
    return bvp;
  } catch {
    return null;
  }
};

// ---------- per-team builders ----------

const buildPitcherSkeleton = async (feed, side, season) => {
  const probable = feed.gameData.probablePitchers?.[side];
  if (!probable?.id) return null;

  const players = feed.gameData.players || {};
  const boxPlayers = feed.liveData?.boxscore?.teams?.[side]?.players || {};
  const key = `ID${probable.id}`;
  const meta = players[key] || {};
  const pbox = boxPlayers[key] || {};
  const ps = pbox.seasonStats?.pitching || {};

  return {
    id: probable.id,
    name: meta.fullName || probable.fullName || '',
    slug: meta.nameSlug || '',
    throws: meta.pitchHand?.code || '',
    jersey: meta.primaryNumber || '',
    w: num(ps.wins),
    l: num(ps.losses),
    era: ps.era || '-.--',
    whip: ps.whip || '-',
    k: num(ps.strikeOuts),
    arsenal: await getArsenal(probable.id, season),
  };
};

const buildTeamSkeleton = async (feed, side, standings, season) => {
  const teamData = feed.gameData.teams?.[side] || {};
  const leagueRec = teamData.record?.leagueRecord || {};
  return {
    teamId: teamData.id,
    abbr: teamData.abbreviation || '',
    name: teamData.name || '',
    record: `${num(leagueRec.wins)}-${num(leagueRec.losses)}`,
    standing: teamStanding(standings, teamData.id),
    pitcher: await buildPitcherSkeleton(feed, side, season),
    lineup: [],
    bvp: {},
  };
};

// Build the lineup rows from a boxscore response (the same one pollLineups
// already fetches). Falls back to feed/live's nested boxscore if no boxscore
// argument is supplied.
const buildLineupRows = (boxTeam, players = {}) => {
  const boxPlayers = boxTeam?.players || {};
  const battingOrder = boxTeam?.battingOrder || [];

  return battingOrder.map((pid) => {
    const key = `ID${pid}`;
    const meta = players[key] || {};
    const bp = boxPlayers[key] || {};
    const s = bp.seasonStats?.batting || {};
    return {
      id: pid,
      name: meta.fullName || bp.person?.fullName || '',
      slug: meta.nameSlug || '',
      pos: bp.position?.abbreviation || meta.primaryPosition?.abbreviation || '',
      bats: meta.batSide?.code || '',
      hr: num(s.homeRuns),
      rbi: num(s.rbi),
      sb: num(s.stolenBases),
      avg: s.avg || '.000',
      obp: s.obp || '.000',
      slg: s.slg || '.000',
      ops: s.ops || '.000',
      ab: num(s.atBats),
    };
  });
};

// ---------- public API ----------

// Build the pre-game skeleton (no lineups, no BvP) for a single game and
// write to disk. `game` is the raw scoreboard game object that fetchMLBGames
// already has. Returns the detail object on success or null on failure.
export const buildSkeletonForGame = async (game) => {
  const gamePk = game.gamePk;
  const season = String(new Date(game.gameDate || Date.now()).getFullYear());

  let feed;
  try {
    feed = await fetchJson(`${STATS_V11}/game/${gamePk}/feed/live`);
  } catch (error) {
    console.error(`[gameDetails] feed/live failed for ${gamePk}:`, error.message);
    return null;
  }

  const standings = await getStandings(season);
  const venue = feed.gameData.venue || {};
  const weather = feed.gameData.weather || {};
  const officials = feed.liveData?.boxscore?.officials || [];

  const away = await buildTeamSkeleton(feed, 'away', standings, season);
  const home = await buildTeamSkeleton(feed, 'home', standings, season);

  let scheduleEntry = null;
  try {
    const sched = await fetchJson(`${STATS}/schedule?sportId=1&gamePk=${gamePk}&hydrate=broadcasts`);
    scheduleEntry = sched?.dates?.[0]?.games?.find((g) => g.gamePk === gamePk) || null;
  } catch {
    // broadcasts optional
  }

  const detail = {
    gamePk,
    updatedAt: new Date().toISOString(),
    venue: {
      name: venue.name || '',
      location: venue.location
        ? `${venue.location.city || ''}, ${venue.location.stateAbbrev || venue.location.state || ''}`.replace(/^, |, $/g, '')
        : '',
      roof: venue.fieldInfo?.roofType || 'Open',
      capacity: venue.fieldInfo?.capacity,
      dimensions: {
        lf: venue.fieldInfo?.leftLine,
        cf: venue.fieldInfo?.center,
        rf: venue.fieldInfo?.rightLine,
      },
    },
    weather: {
      temp: weather.temp ? `${weather.temp}°F` : '',
      condition: weather.condition || '',
      wind: weather.wind || '',
    },
    umpires: officials.map((o) => ({
      role: OFFICIAL_ABBR[o.officialType] || o.officialType,
      name: o.official?.fullName || '',
    })),
    broadcasts: scheduleEntry
      ? buildBroadcasts(scheduleEntry)
      : { tv: [], radio: [] },
    away,
    home,
  };

  writeDetailFile(gamePk, detail);
  return detail;
};

// Convenience: build skeletons for every game on the slate. Used by
// fetchMLBGames after writing latest.json. Runs sequentially to keep the
// rate friendly to MLB.
export const buildAllSkeletons = async (rawGames) => {
  if (!rawGames?.length) return;
  console.log(`[gameDetails] Building skeleton details for ${rawGames.length} games`);
  for (const game of rawGames) {
    try {
      await buildSkeletonForGame(game);
    } catch (error) {
      console.error(`[gameDetails] skeleton failed for ${game.gamePk}:`, error.message);
    }
  }
  console.log('[gameDetails] Skeleton build complete');
};

// Enrich an existing detail file with one team's lineup + BvP. Called from
// pollLineups when a fresh boxscore returns a populated battingOrder for a
// side. `boxscore` is the response from /api/v1/game/{gamePk}/boxscore;
// `feedPlayers` is the gameData.players map (for slug/batSide), which we'll
// re-fetch lazily if not provided.
export const enrichDetailWithLineup = async (gamePk, side, boxscore, feedPlayers = null) => {
  const detail = readDetailFile(gamePk);
  if (!detail) {
    console.warn(`[gameDetails] no skeleton found for ${gamePk}, skipping enrichment`);
    return null;
  }

  const boxTeam = boxscore?.teams?.[side];
  if (!boxTeam?.battingOrder?.length) return detail;

  // Lazy-load player metadata (slug/batSide) — only needed if not already
  // supplied. Most callers won't pass it; the feed/live call is ~50-200KB
  // pre-game which is acceptable for the enrichment cadence.
  let players = feedPlayers;
  if (!players) {
    try {
      const feed = await fetchJson(`${STATS_V11}/game/${gamePk}/feed/live`);
      players = feed.gameData?.players || {};
    } catch (error) {
      console.error(`[gameDetails] enrich feed fetch failed for ${gamePk}:`, error.message);
      players = {};
    }
  }

  const lineup = buildLineupRows(boxTeam, players);
  detail[side].lineup = lineup;

  // BvP for each batter vs opposing probable pitcher.
  const opposingSide = side === 'away' ? 'home' : 'away';
  const opposingPitcherId = detail[opposingSide]?.pitcher?.id;

  let bvpDirty = false;
  if (opposingPitcherId) {
    for (const batter of lineup) {
      const cacheKey = `${batter.id}-${opposingPitcherId}`;
      const alreadyCached = bvpCache.has(cacheKey);
      const bvp = await getBvP(batter.id, opposingPitcherId);
      detail[side].bvp[batter.id] = bvp;
      if (!alreadyCached) bvpDirty = true;
    }
  }

  detail.updatedAt = new Date().toISOString();
  writeDetailFile(gamePk, detail);

  if (bvpDirty) persistBvpCache();
  return detail;
};
