import dotenv from 'dotenv';
dotenv.config();

import { pollGameAlerts } from './services/gameAlerts.js';


//////////////////////////////////////////
// CONSTRUCTOR
const init = async () => {
  // try {
  //   await agent.login({
  //     identifier: process.env.BSKY_IDENTIFIER,
  //     password: process.env.BSKY_APP_PASSWORD,
  //   });
  //   await pollLineupFeed();
  //   await pollGameAlerts();
  // } catch (error) {
  //   console.error('Error logging in to Bluesky:', error);
  // }

  await pollGameAlerts();
};






init();