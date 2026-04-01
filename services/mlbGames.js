import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

import { formatGameTime, buildLineup, formatPitcherStats } from '../utils/formatters.js';
import { postToDiscord } from '../services/postToDiscord.js';
import { enrichGamesWithOdds } from '../services/oddsFeed.js';
import { fetchVenueDetails, enrichGamesWithWeather } from '../services/weather.js';

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Phoenix';

const SCOREBOARD_URL = (date) =>
  `https://bdfed.stitch.mlbinfra.com/bdfed/transform-milb-scoreboard?stitch_env=prod&sortTemplate=4&sportId=1&startDate=${date}&endDate=${date}`;

const MLB_GAMES_FILE = path.resolve('./mlb-games.json');
const SITE_DATA_DIR = process.env.SITE_DATA_DIR
  ? path.resolve(process.env.SITE_DATA_DIR)
  : path.resolve('./site-data');
const SITE_LATEST_FILE = path.resolve(SITE_DATA_DIR, 'latest.json');
const LOCAL_FRONTEND_DATA_FILE = path.resolve('../mlb-lineup-site/public/data/latest.json');

const ensureSiteDataDir = () => {
  if (!fs.existsSync(SITE_DATA_DIR)) {
    fs.mkdirSync(SITE_DATA_DIR, { recursive: true });
  }
};

const writeJsonAtomic = (filePath, payload) => {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempFile, filePath);
};

const buildVenueString = (game) => {
  const venueName = game?.teams?.home?.team?.venue?.name || game?.venue?.name || 'TBD';
  const city = game?.teams?.home?.team?.locationName || game?.venue?.location?.city || '';
  const state = game?.venue?.location?.stateAbbrev || '';

  const locationBits = [city, state].filter(Boolean).join(', ');
  return locationBits ? `${venueName}, ${locationBits}` : venueName;
};

const buildRecordString = (record = {}) => {
  const { wins = 0, losses = 0 } = record;
  return `${wins}-${losses}`;
};

const buildPitcherPayload = (probablePitcher) => {
  if (!probablePitcher) {
    return {
      name: 'TBD',
      stats: '-',
    };
  }

  const hand = probablePitcher?.pitchHand?.code ? ` (${probablePitcher.pitchHand.code})` : '';

  return {
    name: `${probablePitcher.fullName}${hand}`,
    stats: formatPitcherStats(probablePitcher),
  };
};

const buildSiteGame = (game, roofType = 'Open') => ({
  gamePk: game.gamePk,
  gameGuid: game.gameGuid,
  sortTime: DateTime.fromISO(game.gameDate).toFormat('HH:mm'),
  time: formatGameTime(game.gameDate),
  gameDate: game.gameDate,
  officialDate: game.officialDate,
  venue: buildVenueString(game),
  roofType,
  status: game?.status?.detailedState || 'Scheduled',
  weather: '-',
  total: '-',
  line: '-',
  away: {
    teamId: game.teams.away.team.id,
    abbr: game.teams.away.team.abbreviation,
    name: game.teams.away.team.name,
    record: buildRecordString(game.teams.away.leagueRecord),
    pitcher: buildPitcherPayload(game.teams.away.probablePitcher),
    lineup: [],
    note: 'Lineup pending',
  },
  home: {
    teamId: game.teams.home.team.id,
    abbr: game.teams.home.team.abbreviation,
    name: game.teams.home.team.name,
    record: buildRecordString(game.teams.home.leagueRecord),
    pitcher: buildPitcherPayload(game.teams.home.probablePitcher),
    lineup: [],
    note: 'Lineup pending',
  },
});

const loadExistingSitePayload = () => {
  if (!fs.existsSync(SITE_LATEST_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(SITE_LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const preserveExistingLineups = (games, existingPayload) => {
  if (!existingPayload?.games?.length) {
    return games;
  }

  const existingByGamePk = new Map(existingPayload.games.map((game) => [game.gamePk, game]));

  return games.map((game) => {
    const existingGame = existingByGamePk.get(game.gamePk);
    if (!existingGame) return game;

    for (const side of ['away', 'home']) {
      if (existingGame?.[side]?.lineup?.length) {
        game[side].lineup = existingGame[side].lineup;
        game[side].note = null;
      }
    }

    return game;
  });
};

const writeSiteJson = (games, date) => {
  ensureSiteDataDir();

  const payload = {
    date,
    updatedAt: new Date().toISOString(),
    games,
  };

  writeJsonAtomic(SITE_LATEST_FILE, payload);

  if (!process.env.SITE_DATA_DIR) {
    writeJsonAtomic(LOCAL_FRONTEND_DATA_FILE, payload);
  }
};

const syncSiteLineup = (siteGames, lineup, teamType, gamePk) => {
  const siteGame = siteGames.find((game) => game.gamePk === gamePk);
  if (!siteGame) return;

  const target = siteGame[teamType];
  target.lineup = lineup.map((player) => ({
    name: player.name,
    position: player.position,
    bats: player.bats,
  }));
  target.note = null;
};

const syncSitePayloadFromGames = (sitePayload, games) => {
  if (!sitePayload?.games?.length) {
    return sitePayload;
  }

  const gamesByPk = new Map(games.map((game) => [game.gamePk, game]));

  for (const siteGame of sitePayload.games) {
    const sourceGame = gamesByPk.get(siteGame.gamePk);
    if (!sourceGame) continue;

    if (sourceGame.awayLineup?.length) {
      siteGame.away.lineup = sourceGame.awayLineup.map((player) => ({
        name: player.name,
        position: player.position,
        bats: player.bats,
      }));
      siteGame.away.note = null;
    }

    if (sourceGame.homeLineup?.length) {
      siteGame.home.lineup = sourceGame.homeLineup.map((player) => ({
        name: player.name,
        position: player.position,
        bats: player.bats,
      }));
      siteGame.home.note = null;
    }
  }

  return sitePayload;
};

export const fetchMLBGames = async () => {
  const today = DateTime.now().setZone(APP_TIMEZONE).toFormat('yyyy-MM-dd');
  const res = await fetch(SCOREBOARD_URL(today));
  const data = await res.json();

  const rawGames = data.dates?.[0]?.games || [];

  let existingGames = new Map();
  try {
    const existing = JSON.parse(fs.readFileSync(MLB_GAMES_FILE, 'utf8'));
    existingGames = new Map(existing.map((g) => [g.gamePk, g]));
  } catch {
    // no existing file or invalid JSON — start fresh
  }

  const games = rawGames.map((game) => {
    const prev = existingGames.get(game.gamePk);
    return {
      home: game.teams.home.team.name,
      homePitcher: game.teams.home.probablePitcher?.nameFirstLast || null,
      homePitcherHand: game.teams.home.probablePitcher?.pitchHand.code || null,
      homePosted: prev?.homePosted || false,
      homeLineup: prev?.homeLineup || [],
      away: game.teams.away.team.name,
      awayPitcher: game.teams.away.probablePitcher?.nameFirstLast || null,
      awayPitcherHand: game.teams.away.probablePitcher?.pitchHand.code || null,
      awayPosted: prev?.awayPosted || false,
      awayLineup: prev?.awayLineup || [],
      venue: game.teams.home.team.venue?.name || 'TBD',
      city: game.teams.home.team.locationName || '',
      state: game.venue?.location?.stateAbbrev || '',
      gamePk: game.gamePk,
      gameTime: formatGameTime(game.gameDate),
      gameDate: game.gameDate,
    };
  });

  fs.writeFileSync(MLB_GAMES_FILE, JSON.stringify(games, null, 2), 'utf8');

  // Fetch roof type for each venue
  const venueDetailsMap = new Map();
  for (const game of rawGames) {
    const venueId = game.venue?.id;
    if (venueId && !venueDetailsMap.has(venueId)) {
      venueDetailsMap.set(venueId, await fetchVenueDetails(venueId));
    }
  }

  const existingSitePayload = loadExistingSitePayload();

  const siteGames = preserveExistingLineups(
    rawGames
      .map((game) => {
        const details = venueDetailsMap.get(game.venue?.id) || {};
        return buildSiteGame(game, details.roofType || 'Open');
      })
      .sort((a, b) => a.sortTime.localeCompare(b.sortTime)),
    existingSitePayload
  );

  await enrichGamesWithOdds(siteGames, today);
  await enrichGamesWithWeather(siteGames, rawGames);
  writeSiteJson(siteGames, today);
};

const refreshTBDPitchers = async (games, sitePayload) => {
  const tbdGames = games.filter(
    (g) => !g.awayPitcher || !g.homePitcher
  );

  if (!tbdGames.length) return;

  const today = DateTime.now().setZone(APP_TIMEZONE).toFormat('yyyy-MM-dd');
  let rawGames;
  try {
    const res = await fetch(SCOREBOARD_URL(today));
    const data = await res.json();
    rawGames = data.dates?.[0]?.games || [];
  } catch (error) {
    console.error('Error refreshing TBD pitchers:', error);
    return;
  }

  const rawByPk = new Map(rawGames.map((g) => [g.gamePk, g]));

  for (const game of tbdGames) {
    const raw = rawByPk.get(game.gamePk);
    if (!raw) continue;

    for (const side of ['away', 'home']) {
      const pitcherKey = `${side}Pitcher`;
      const handKey = `${side}PitcherHand`;

      if (!game[pitcherKey] && raw.teams[side].probablePitcher) {
        const pp = raw.teams[side].probablePitcher;
        game[pitcherKey] = pp.nameFirstLast || pp.fullName;
        game[handKey] = pp.pitchHand?.code || null;
        console.log(`Updated ${side} pitcher for ${game[side]}: ${game[pitcherKey]}`);

        if (sitePayload?.games?.length) {
          const siteGame = sitePayload.games.find((sg) => sg.gamePk === game.gamePk);
          if (siteGame) {
            siteGame[side].pitcher = buildPitcherPayload(pp);
          }
        }
      }
    }
  }
};

export const pollLineups = async () => {
  const fileData = fs.readFileSync(MLB_GAMES_FILE, 'utf8');
  if (!fileData) return;

  const games = JSON.parse(fileData);

  let sitePayload = null;
  if (fs.existsSync(SITE_LATEST_FILE)) {
    sitePayload = JSON.parse(fs.readFileSync(SITE_LATEST_FILE, 'utf8'));
  }

  await refreshTBDPitchers(games, sitePayload);

  for (const game of games) {
    if (game.awayPosted && game.homePosted) {
      continue;
    }

    const boxscoreUrl = `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`;
    const res = await fetch(boxscoreUrl);
    const data = await res.json();

    if (!game.awayPosted) {
      const awayLineup = buildLineup(data.teams?.away, data.teams.away.players);

      if (awayLineup) {
        game.awayPosted = true;
        game.awayLineup = awayLineup;
        await postLineups(game, awayLineup, 'away');
      }
    }

    if (!game.homePosted) {
      const homeLineup = buildLineup(data.teams?.home, data.teams.home.players);

      if (homeLineup) {
        game.homePosted = true;
        game.homeLineup = homeLineup;
        await postLineups(game, homeLineup, 'home');
      }
    }
  }

  fs.writeFileSync(MLB_GAMES_FILE, JSON.stringify(games, null, 2), 'utf8');

  if (sitePayload) {
    const syncedPayload = syncSitePayloadFromGames(sitePayload, games);
    syncedPayload.updatedAt = new Date().toISOString();
    writeJsonAtomic(SITE_LATEST_FILE, syncedPayload);

    if (!process.env.SITE_DATA_DIR) {
      writeJsonAtomic(LOCAL_FRONTEND_DATA_FILE, syncedPayload);
    }
  }
};

const postLineups = async (game, lineup, teamType) => {
  const mappings = {
    away: {
      teamName: game.away,
      pitcher: game.awayPitcher,
      pitcherHand: game.awayPitcherHand,
      opponentName: game.home,
      opponentPitcher: game.homePitcher,
      opponentPitcherHand: game.homePitcherHand,
    },
    home: {
      teamName: game.home,
      pitcher: game.homePitcher,
      pitcherHand: game.homePitcherHand,
      opponentName: game.away,
      opponentPitcher: game.awayPitcher,
      opponentPitcherHand: game.awayPitcherHand,
    },
  };
  const { teamName, pitcher, pitcherHand, opponentName, opponentPitcher, opponentPitcherHand } = mappings[teamType];

  const lineupHeader = `**${teamName}**: ${DateTime.fromISO(game.gameDate, { zone: 'America/New_York' }).toFormat('M/d')}`;
  const lineupBody = lineup
    .map((p) => `${p.order}. ${p.name} - ${p.position}${p.bats ? ` (${p.bats})` : ''}`)
    .join('\n');
  const lineupPitcher = `**SP**: ${pitcher} (${pitcherHand}HP)`;
  const lineupTime = `**First Pitch**: ${game.gameTime}`;
  const lineupOpponent = `**Opponent**: ${opponentName}`;
  const vsPitcher = `**Opposing Pitcher**: ${opponentPitcher} (${opponentPitcherHand}HP)`;
  const lineupLocation = `**Location**: ${game.venue}, ${game.city}, ${game.state}`;

  const message = `\n\n⚾️ Lineup ⚾️\n\n${lineupHeader}\n\n${lineupBody}\n\n${lineupPitcher}\n\n${lineupTime}\n${lineupOpponent}\n${vsPitcher}\n${lineupLocation}\n\n----------------------\n\n`;

  await postToDiscord(message);
};
