import fetch from 'node-fetch';
import { DateTime } from 'luxon';

const ODDS_API_BASE = 'https://odds-feed.p.rapidapi.com/api/v1';
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const MLB_SPORT_ID = 5;

const headers = () => ({
  'x-rapidapi-key': ODDS_API_KEY,
});

const normalizeTeamName = (name = '') =>
  name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const teamAliases = new Map([
  ['new york yankees', 'new york yankees'],
  ['new york mets', 'new york mets'],
  ['los angeles dodgers', 'los angeles dodgers'],
  ['los angeles angels', 'los angeles angels'],
  ['san diego padres', 'san diego padres'],
  ['san francisco giants', 'san francisco giants'],
  ['kansas city royals', 'kansas city royals'],
  ['athletics', 'athletics'],
  ['oakland athletics', 'athletics'],
  ['tampa bay rays', 'tampa bay rays'],
  ['chicago cubs', 'chicago cubs'],
  ['chicago white sox', 'chicago white sox'],
]);

const canonicalTeamName = (name = '') => teamAliases.get(normalizeTeamName(name)) || normalizeTeamName(name);

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(`Odds API request failed (${response.status})`);
  }
  return response.json();
};

const decimalToAmerican = (decimalOdds) => {
  const decimal = Number(decimalOdds);
  if (Number.isNaN(decimal) || decimal <= 1) return null;

  if (decimal >= 2) {
    return Math.round((decimal - 1) * 100);
  }

  return Math.round(-100 / (decimal - 1));
};

const formatMoneyline = (teamAbbr, decimalOdds) => {
  const american = decimalToAmerican(decimalOdds);
  if (american == null) return '-';
  return `${teamAbbr} ${american > 0 ? `+${american}` : american}`;
};

const formatTotal = (value) => {
  if (value == null) return '-';
  const num = Number(value);
  return Number.isNaN(num) ? '-' : `${num}`;
};

const average = (values) => {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const getConsensusMoneyline = (market, game) => {
  const books = getOpenBooks(market);
  if (!books.length) return '-';

  let homeFavored = 0;
  let awayFavored = 0;

  for (const book of books) {
    const homePrice = Number(book.outcome_0);
    const awayPrice = Number(book.outcome_1);
    if (Number.isNaN(homePrice) || Number.isNaN(awayPrice)) continue;

    if (homePrice < awayPrice) {
      homeFavored += 1;
    } else if (awayPrice < homePrice) {
      awayFavored += 1;
    }
  }

  const favoredIsHome = homeFavored > awayFavored;
  const favoredPrices = books
    .map((book) => ({ home: Number(book.outcome_0), away: Number(book.outcome_1) }))
    .filter(({ home, away }) => !Number.isNaN(home) && !Number.isNaN(away))
    .filter(({ home, away }) => (favoredIsHome ? home < away : away < home))
    .map(({ home, away }) => (favoredIsHome ? home : away));

  const avgPrice = average(favoredPrices);
  if (avgPrice == null) return '-';

  return favoredIsHome
    ? formatMoneyline(game.home.abbr, avgPrice)
    : formatMoneyline(game.away.abbr, avgPrice);
};

const getConsensusTotal = (markets) => {
  const openTotals = markets
    .filter((market) => getOpenBooks(market).length > 0)
    .map((market) => Number(market.value))
    .filter((value) => !Number.isNaN(value))
    .filter((value) => value >= 6 && value <= 12);

  if (!openTotals.length) return '-';

  const counts = new Map();
  for (const total of openTotals) {
    counts.set(total, (counts.get(total) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] - b[0];
  });

  return formatTotal(sorted[0]?.[0]);
};

const getOpenBooks = (market) => (market?.market_books || []).filter((book) => book?.is_open);

const toUtcMillis = (value) => {
  if (!value) return null;

  if (value.includes('T')) {
    return DateTime.fromISO(value, { zone: 'utc' }).toMillis();
  }

  return DateTime.fromSQL(value, { zone: 'utc' }).toMillis();
};

const findEventForGame = (events, game) => {
  const awayName = canonicalTeamName(game.away.name);
  const homeName = canonicalTeamName(game.home.name);
  const gameTime = toUtcMillis(game.gameDate);

  const candidates = events.filter((event) => {
    const eventAway = canonicalTeamName(event?.team_away?.name || '');
    const eventHome = canonicalTeamName(event?.team_home?.name || '');
    return awayName === eventAway && homeName === eventHome;
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .map((event) => ({
      event,
      diff: Math.abs((toUtcMillis(event.start_at) ?? Number.MAX_SAFE_INTEGER) - gameTime),
    }))
    .sort((a, b) => a.diff - b.diff)[0]?.event || null;
};

const enrichGameWithMarkets = async (eventId, game) => {
  const [moneylineRes, totalRes] = await Promise.all([
    fetchJson(`${ODDS_API_BASE}/events/markets?event_id=${eventId}&placing=PREMATCH&market_name=HOME_AWAY`),
    fetchJson(`${ODDS_API_BASE}/events/markets?event_id=${eventId}&placing=PREMATCH&market_name=OVER_UNDER`),
  ]);

  const moneylineMarket = moneylineRes?.data?.[0];
  if (moneylineMarket) {
    game.line = getConsensusMoneyline(moneylineMarket, game);
  }

  if (Array.isArray(totalRes?.data) && totalRes.data.length > 0) {
    game.total = getConsensusTotal(totalRes.data);
  }

  return game;
};

export const enrichGamesWithOdds = async (games, officialDate) => {
  if (!ODDS_API_KEY) {
    return games;
  }

  try {
    const start = DateTime.fromISO(officialDate, { zone: 'utc' }).minus({ hours: 6 }).toFormat('yyyy-MM-dd HH:mm:ss');
    const end = DateTime.fromISO(officialDate, { zone: 'utc' }).plus({ days: 1, hours: 12 }).toFormat('yyyy-MM-dd HH:mm:ss');
    const params = new URLSearchParams({
      sport_id: String(MLB_SPORT_ID),
      status: 'SCHEDULED',
      start_at_min: start,
      start_at_max: end,
      page: '0',
    });

    const eventsRes = await fetchJson(`${ODDS_API_BASE}/events?${params.toString()}`);
    const events = eventsRes?.data || [];

    for (const game of games) {
      const event = findEventForGame(events, game);
      if (!event?.id) {
        continue;
      }

      try {
        await enrichGameWithMarkets(event.id, game);
      } catch (error) {
        console.error(`Odds enrichment failed for ${game.away.abbr} @ ${game.home.abbr}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Odds enrichment skipped:', error.message);
  }

  return games;
};
