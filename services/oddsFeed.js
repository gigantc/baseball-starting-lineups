import fetch from 'node-fetch';
import { DateTime } from 'luxon';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;
const MLB_SPORT_KEY = 'baseball_mlb';

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
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Odds API request failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return {
    data: await response.json(),
    headers: {
      remaining: response.headers.get('x-requests-remaining'),
      used: response.headers.get('x-requests-used'),
      last: response.headers.get('x-requests-last'),
    },
  };
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

const getConsensusMoneyline = (event, game) => {
  const pricedBooks = event.bookmakers
    ?.map((book) => {
      const market = book.markets?.find((m) => m.key === 'h2h');
      const home = market?.outcomes?.find((o) => canonicalTeamName(o.name) === canonicalTeamName(game.home.name));
      const away = market?.outcomes?.find((o) => canonicalTeamName(o.name) === canonicalTeamName(game.away.name));
      return { home: Number(home?.price), away: Number(away?.price) };
    })
    .filter(({ home, away }) => !Number.isNaN(home) && !Number.isNaN(away)) || [];

  if (!pricedBooks.length) return '-';

  let homeFavored = 0;
  let awayFavored = 0;

  for (const book of pricedBooks) {
    if (book.home < book.away) homeFavored += 1;
    else if (book.away < book.home) awayFavored += 1;
  }

  const favoredIsHome = homeFavored >= awayFavored;
  const favoredPrices = pricedBooks
    .filter(({ home, away }) => (favoredIsHome ? home < away : away < home))
    .map(({ home, away }) => (favoredIsHome ? home : away));

  const avgPrice = average(favoredPrices);
  if (avgPrice == null) return '-';

  return favoredIsHome
    ? `${game.home.abbr} ${avgPrice > 0 ? `+${Math.round(avgPrice)}` : Math.round(avgPrice)}`
    : `${game.away.abbr} ${avgPrice > 0 ? `+${Math.round(avgPrice)}` : Math.round(avgPrice)}`;
};

const getConsensusTotal = (event) => {
  const candidates = event.bookmakers
    ?.map((book) => book.markets?.find((m) => m.key === 'totals'))
    .filter(Boolean)
    .map((market) => {
      const over = market.outcomes?.find((o) => o.name === 'Over');
      const under = market.outcomes?.find((o) => o.name === 'Under');
      return {
        point: Number(over?.point ?? under?.point),
        over: Number(over?.price),
        under: Number(under?.price),
      };
    })
    .filter(({ point, over, under }) => !Number.isNaN(point) && !Number.isNaN(over) && !Number.isNaN(under)) || [];

  if (!candidates.length) return '-';

  let bestValue = null;
  let bestImbalance = Infinity;

  for (const candidate of candidates) {
    const imbalance = Math.abs(candidate.over - candidate.under);
    if (imbalance < bestImbalance) {
      bestImbalance = imbalance;
      bestValue = candidate.point;
    }
  }

  return formatTotal(bestValue);
};

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
    const eventAway = canonicalTeamName(event?.away_team || event?.team_away?.name || '');
    const eventHome = canonicalTeamName(event?.home_team || event?.team_home?.name || '');
    return awayName === eventAway && homeName === eventHome;
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .map((event) => ({
      event,
      diff: Math.abs((toUtcMillis(event.commence_time || event.start_at) ?? Number.MAX_SAFE_INTEGER) - gameTime),
    }))
    .sort((a, b) => a.diff - b.diff)[0]?.event || null;
};

const enrichGameWithMarkets = (event, game) => {
  game.line = getConsensusMoneyline(event, game);
  game.total = getConsensusTotal(event);
  return game;
};

// Odds are intentionally fetched only during morning slate creation.
// This app is not a live odds product, so one daily snapshot is enough and keeps
// The Odds API free-tier usage extremely low (currently 2 credits per slate fetch).
export const enrichGamesWithOdds = async (games, officialDate) => {
  if (!ODDS_API_KEY) {
    return games;
  }

  try {
    const start = DateTime.fromISO(officialDate, { zone: 'utc' }).minus({ hours: 6 }).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
    const end = DateTime.fromISO(officialDate, { zone: 'utc' }).plus({ days: 1, hours: 12 }).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
    const params = new URLSearchParams({
      apiKey: ODDS_API_KEY,
      regions: 'us',
      markets: 'h2h,totals',
      oddsFormat: 'american',
      dateFormat: 'iso',
      commenceTimeFrom: start,
      commenceTimeTo: end,
    });

    const { data: events, headers } = await fetchJson(`${ODDS_API_BASE}/sports/${MLB_SPORT_KEY}/odds/?${params.toString()}`);
    console.log(`Odds API credits used for morning slate: ${headers.last}, remaining: ${headers.remaining}`);

    for (const game of games) {
      const event = findEventForGame(events || [], game);
      if (!event) {
        continue;
      }

      enrichGameWithMarkets(event, game);
    }
  } catch (error) {
    console.error('Odds enrichment skipped:', error.message);
  }

  return games;
};
