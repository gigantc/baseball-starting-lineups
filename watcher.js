import dotenv from 'dotenv';
// import { DateTime } from 'luxon';
dotenv.config();
import fetch from 'node-fetch';
import fs from 'fs';
import { AtpAgent } from '@atproto/api';


// import { teamAbbreviations } from './utils/teamMap.js';
import { getFormattedHeader, getOpponent, formatLineup, formatGameTime } from './utils/formatters.js';
import { loadSeenPosts, saveSeenPosts } from './utils/storage.js';



//////////////////////////////////////////
// Constants
const isProduction = process.env.ENVIRONMENT === 'production';

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

// Poll every 2 mintes
const POLL_LINEUP_INTERVAL = 60000;
// Poll every 5 minutes
const POLL_ALERTS_INTERVAL = 300000;

//the seen posts file
const SEEN_POSTS_FILE = './seen-posts.json';

//we only want alert posts that start with this, so we'll filter them out
const alertKeywords = ['game alert', 'lineup alert', 'postponed', 'weather', 'scratched'];

//watching keywords to potentailly add news later
const newsKeywords = ['Hyde', 'Passan', 'Feinsand', 'Rosenthal', 'Weyrich', 'Murray', 'Francona', 'Roberts', 'Friedman', 'per', 'Boone', 'Espada', 'McCullough'];



//////////////////////////////////////////
// Feed Processing
const seenPosts = loadSeenPosts();
const agent = new AtpAgent({ service: 'https://bsky.social' });

// Logs in to Bluesky and starts polling
const init = async () => {
  try {
    await agent.login({
      identifier: process.env.BSKY_IDENTIFIER,
      password: process.env.BSKY_APP_PASSWORD,
    });
    await pollLineupFeed();
    await pollGameAlerts();
  } catch (error) {
    console.error('Error logging in to Bluesky:', error);
  }
};

// Post the final message to Discord
const postToDiscord = async (message) => {
  if (isProduction) {
    if (process.env.DISCORD_WEBHOOK_URL) {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
    } else {
      console.error('DISCORD_WEBHOOK_URL is not defined.');
    }
  } else {
    console.log(message);
  }
};


// Grabs the Bluesky feed and processes posts
// this is for LINEUP DATA
const pollLineupFeed = async () => {
  try {

    // Fetches the latest posts from the target Bluesky account
    const feed = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: 'lineupbot.bsky.social',
      limit: 10,
    });

    for (const post of feed.data.feed) {
      // Converts post text to lowercase for keyword matching
      const text = post.post.record.text;
      const cid = post.post.cid;
      
      //let's get the post header 
      const headerLine = post.post.record.text.split('\n')[0];
      const lineupHeader = getFormattedHeader(headerLine);

      //let's format the starting lineup
      const lineupBody = formatLineup(text);

      //let's format the game time
      const lineupTime = formatGameTime(text);

      //and finally the opponent
      const lineupOpponent = getOpponent(headerLine);


      // If post matches criteria and hasn't been processed yet
      //also filters out anything that isn't a lineup in case this user posts something different.
      if (lineupHeader && !seenPosts.has(cid)) {
        
        const message = `⚾️ New Lineup:\n\n${lineupHeader}\n\n${lineupBody}${lineupTime}\nOpponent: ${lineupOpponent}\n\n----------------------\n\n`;

        // Adds post to seenPosts and saves to disk
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);

       // Sends to Discord if in production, logs to console if local
        await postToDiscord(message);

        // stop after first new alert
        // the next one will auto queue
        break; 
      }
    }
  } catch (error) {
    console.error('Error fetching feed:', error);
  }

  // Schedule the next feed poll after delay
  setTimeout(pollLineupFeed, POLL_LINEUP_INTERVAL);
};



// Grabs the Bluesky feed and processes posts
// this is for LINEUP DATA
const pollGameAlerts = async () => {
  try {
    // Fetches the latest posts from the game alerts Bluesky account
    const feed = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: 'fantasymlbnews.bsky.social',
      limit: 20,
    });

    for (const post of feed.data.feed) {
      // Converts post text to lowercase for keyword matching
      const text = post.post.record.text.toLowerCase();
      const cid = post.post.cid;

      // Checks if post contains any alert keywords
      const isAlertPost = alertKeywords.some((word) => text.includes(word));

      //set the text in the Alert heading
      const matchedKeyword = alertKeywords.find((word) => text.includes(word));

      let alertType = matchedKeyword === 'lineup alert' ? 'Lineup Alert' : 'Game Alert';
      // additional alert types
      if (matchedKeyword == 'postponed' || 'weather'){
        alertType = 'Game Alert'
      }
      if (matchedKeyword == 'scratched'){
        alertType = 'Lineup Alert'
      }

      //cleans the text so we don't repeat “game alert:” or “lineup alert:”
      const cleanedText = ['game alert', 'lineup alert'].includes(matchedKeyword)
  ? post.post.record.text.replace(new RegExp(`${matchedKeyword}:?\\s*`, 'i'), '').trim()
  : post.post.record.text;

      // If post matches alert criteria and hasn't been processed yet
      if (isAlertPost && !seenPosts.has(cid)) {
        const message = `🚨 ${alertType} 🚨\n\n${cleanedText}\n\n----------------------\n\n`;

        // Adds post to seenPosts and saves to disk
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);

        // Sends to Discord if in production, logs to console if local
        await postToDiscord(message);

        // stop after first new alert
        // the next one will auto queue
        break; 
      }
    }
  } catch (error) {
    console.error('Error fetching game alerts feed:', error);
  }

  // Schedule the next game alerts feed poll after delay (4 minutes)
  setTimeout(pollGameAlerts, POLL_ALERTS_INTERVAL);
};






init();