import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

import { formatGameTime } from '../utils/formatters.js';



export const fetchAndStoreMLBGames = async () => {
  const url = 'https://bdfed.stitch.mlbinfra.com/bdfed/transform-milb-scoreboard?stitch_env=prod&sortTemplate=4&sportId=1&startDate=2025-06-30&endDate=2025-06-30';

  const res = await fetch(url);
  const data = await res.json();

  const games = data.dates?.[0]?.games?.map(game => ({
    homeTeam: game.teams.home.team.name,
    awayTeam: game.teams.away.team.name,
    venue: game.venue.name,
    city: game.venue.location.city,
    state: game.venue.location.stateAbbrev,
    gamePk: game.gamePk,
    gameTime: formatGameTime(game.gameDate),
  })) || [];

  const filePath = path.resolve('./mlb-games.json');
  fs.writeFileSync(filePath, JSON.stringify(games, null, 2), 'utf8');

  console.log(`Saved ${games.length} games to mlb-games.json`);
};