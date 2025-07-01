import dotenv from 'dotenv';
dotenv.config();
import { DateTime } from 'luxon';

import { pollGameAlerts } from './services/gameAlerts.js';
import { fetchMLBGames, pollLineups } from './services/mlbGames.js';



//////////////////////////////////////////
// POLLING
// Poll every 5 minutes
//second to minutes for reference
// min      seconds
// 1        60000
// 2        120000
// 3        180000
// 4        240000
// 5        300000
// 6        360000
// 7        420000
// 8        480000
// 9        540000
// 10       600000

const POLL_ALERTS_INTERVAL = 300000;
const POLL_LINEUPS_INTERVAL = 180000;

const scheduleLineupPolling = () => {
  const poll = async () => {
    await pollLineups();
    setTimeout(poll, POLL_LINEUPS_INTERVAL);
  };
  poll();
};

const scheduleAlertsPolling = () => {
  const poll = async () => {
    await pollGameAlerts();
    setTimeout(poll, POLL_ALERTS_INTERVAL);
  };
  poll();
};



//////////////////////////////////////////
// INIT!
const init = async () => {
  // watch bluesky for lineup and game alerts
  scheduleAlertsPolling();

  // grab daily games FIRST
  await scheduleDailyFetch();

  // then watch for new lineups
  scheduleLineupPolling();
};



//////////////////////////////////////////
// DAILY RUN TO GET GAME DATA
// and start looking for lineups

// 24hr format, e.g. 14 for 2pm
const DAILY_FETCH_HOUR = 4; 
const DAILY_FETCH_MINUTE = 30;

const scheduleDailyFetch = () => {
  
  //run right away if we are on dev
  fetchMLBGames();

  const now = DateTime.local();

  //runs this when it hits the time above
  let nextRun = now.set({
    hour: DAILY_FETCH_HOUR,
    minute: DAILY_FETCH_MINUTE,
    second: 0,
    millisecond: 0,
  });
  if (now >= nextRun) {
    nextRun = nextRun.plus({ days: 1 });
  }

  //set this to run again in 24 hours
  const msUntilRun = nextRun.diff(now).as('milliseconds');

  setTimeout(() => {
    fetchMLBGames();
    setInterval(fetchMLBGames, 24 * 60 * 60 * 1000);
  }, msUntilRun);
};











init();