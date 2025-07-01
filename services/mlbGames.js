import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

import { formatGameTime, buildLineup } from '../utils/formatters.js';
import { postToDiscord } from '../services/postToDiscord.js';

//////////////////////////////////////////
// Grab all MLB games for the day
// and create the game object
export const fetchMLBGames = async () => {

  // Let's get the game data for the day.
  const today = DateTime.now().toFormat('yyyy-MM-dd');

  //this is here to manually pull a day in the past
  // const today = "2025-06-30";

  const url = `https://bdfed.stitch.mlbinfra.com/bdfed/transform-milb-scoreboard?stitch_env=prod&sortTemplate=4&sportId=1&startDate=${today}&endDate=${today}`;
  
  const res = await fetch(url);
  const data = await res.json();


  // initial game object
  const games = data.dates?.[0]?.games?.map(game => ({
    home: game.teams.home.team.name,
    homePitcher: game.teams.home.probablePitcher?.nameFirstLast || null,
    homePitcherHand: game.teams.home.probablePitcher?.pitchHand.code || null,
    homePosted: false,
    homeLineup: [],
    away: game.teams.away.team.name,
    awayPitcher: game.teams.away.probablePitcher?.nameFirstLast || null,
    awayPitcherHand: game.teams.away.probablePitcher?.pitchHand.code || null,
    awayPosted: false,
    awayLineup: [],
    venue: game.venue.name,
    city: game.venue.location.city,
    state: game.venue.location.stateAbbrev,
    gamePk: game.gamePk,
    gameTime: formatGameTime(game.gameDate),
    gameDate: game.gameDate,
  })) || [];

  //and let's write that to the json file
  const filePath = path.resolve('./mlb-games.json');
  fs.writeFileSync(filePath, JSON.stringify(games, null, 2), 'utf8');


  // console.log(`Saved ${games.length} games to mlb-games.json`);
};





//////////////////////////////////////////
// POLL the lineups 
export const pollLineups = async () => {

  //path to json data
  const filePath = path.resolve('./mlb-games.json');
  const fileData = fs.readFileSync(filePath, 'utf8');
  //check to make sure things aren't empty
  if (!fileData) {return;}

  const games = JSON.parse(fileData);


  for (const game of games) {

    // Skip if both lineups have been posted
    if (game.awayPosted && game.homePosted) {
      continue;
    }

    //call the mlb boxscore api
    const boxscoreUrl = `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`;
    const res = await fetch(boxscoreUrl);
    const data = await res.json();


    // Check AWAY team lineups
    if (!game.awayPosted) {
      const awayLineup = buildLineup(data.teams?.away, data.teams.away.players);

      if (awayLineup) {
        game.awayPosted = true;
        game.awayLineup = awayLineup;

        // post to discord
        postLineups(game, awayLineup, "away");
      }
    }

    // Check HOME team lineups
    if (!game.homePosted) {
      const homeLineup = buildLineup(data.teams?.home, data.teams.home.players);

      if (homeLineup) {
        game.homePosted = true;
        game.homeLineup = homeLineup;

        // post to discord
        postLineups(game, homeLineup, "home");
      }
    }


  } //end for loop

  // Save updated games list back to mlb-games.json
  fs.writeFileSync(filePath, JSON.stringify(games, null, 2), 'utf8');
};




//////////////////////////////////////////
// FORMAT AND POST LINEUP TO DISCORD
const postLineups = async (game, lineup, teamType) => {

  //switch between home and away teams
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
    }
  };
  const { teamName, pitcher, pitcherHand, opponentName, opponentPitcher, opponentPitcherHand } = mappings[teamType];


  //format message
  const lineupHeader = `**${teamName}**: ${DateTime.fromISO(game.gameDate).toFormat('M/d')}`;

  const lineupBody = lineup.map(p => `${p.order}. ${p.name} - ${p.position}`).join('\n');

  const lineupPitcher = `**SP**: ${pitcher} (${pitcherHand}HP)`;

  const lineupTime = `**First Pitch**: ${game.gameTime}`;
  const lineupOpponent = `**Opponent**: ${opponentName}`;
  const vsPitcher = `**Opposing Pitcher**: ${opponentPitcher} (${opponentPitcherHand}HP)`;
  const lineupLocation = `**Location**: ${game.venue}, ${game.city}, ${game.state}`;

  const message = `\n\n⚾️ Lineup ⚾️\n\n${lineupHeader}\n\n${lineupBody}\n\n${lineupPitcher}\n\n${lineupTime}\n${lineupOpponent}\n${vsPitcher}\n${lineupLocation}\n\n----------------------\n\n`;

  //send it to Discord
  await postToDiscord(message);

};



