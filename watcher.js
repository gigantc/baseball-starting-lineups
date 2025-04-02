import dotenv from 'dotenv';
import { DateTime } from 'luxon';
dotenv.config();
import fetch from 'node-fetch';
import fs from 'fs';
import { AtpAgent } from '@atproto/api';



//////////////////////////////////////////
// Constants
const isProduction = process.env.ENVIRONMENT === 'production';
// Poll every 60 seconds
const POLL_LINEUP_INTERVAL = 60000;
const POLL_ALERTS_INTERVAL = 240000;
const SEEN_POSTS_FILE = './seen-posts.json';

//we only want alert posts that start with this, so we'll filter them out
const alertKeywords = ['game alert', 'lineup alert'];

// Maps team abbreviations to full team names
// Athletics is an exception because they don't have a home 
const teamAbbreviations = {
  ARI: 'Diamondbacks',
  ATL: 'Braves',
  BAL: 'Orioles',
  BOS: 'Red Sox',
  CHC: 'Cubs',
  CIN: 'Reds',
  CLE: 'Guardians',
  COL: 'Rockies',
  CHW: 'White Sox',
  DET: 'Tigers',
  HOU: 'Astros',
  KCR: 'Royals',
  LAA: 'Angels',
  LAD: 'Dodgers',
  MIA: 'Marlins',
  MIL: 'Brewers',
  MIN: 'Twins',
  NYM: 'Mets',
  NYY: 'Yankees',
  Athletics: 'Athletics',
  PHI: 'Phillies',
  PIT: 'Pirates',
  SDP: 'Padres',
  SEA: 'Mariners',
  SFG: 'Giants',
  STL: 'Cardinals',
  TBR: 'Rays',
  TEX: 'Rangers',
  TOR: 'Blue Jays',
  WSH: 'Nationals',
};




//////////////////////////////////////////
// Utility Functions

// Loads seen post IDs from disk if available
const loadSeenPosts = () => {
  try {
    const data = fs.readFileSync(SEEN_POSTS_FILE, 'utf-8');
    const json = JSON.parse(data);
    return new Set(json.posts);
  } catch (error) {
    return new Set();
  }
};

// Saves seen post IDs to disk (limits to last 50 posts)
const saveSeenPosts = (set) => {
  const maxPosts = 50;
  const postsArray = Array.from(set);
  const limitedPosts = postsArray.slice(-maxPosts);
  const json = { posts: limitedPosts };
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(json, null, 2));
};


// Extracts and formats lineup header to "**Team**: M/D"
const getFormattedHeader = (headerLine) => {
  const entries = Object.entries(teamAbbreviations);

  let matchedName = null;

  for (const [key, value] of entries) {
    if (headerLine.toLowerCase().startsWith(key.toLowerCase())) {
      matchedName = value;
      break;
    }
    if (headerLine.toLowerCase().startsWith(value.toLowerCase())) {
      matchedName = value;
      break;
    }
  }

  if (matchedName) {
    const dateMatch = headerLine.match(/(\d{1,2})-(\d{2})/);
    if (dateMatch) {
      const [, month, day] = dateMatch;
      return `**${matchedName}**: ${month}/${day}`;
    }
  }

  return null;
};



// Extracts opponent team name from header line
const getOpponent = (headerLine) => {
  const entries = Object.entries(teamAbbreviations);
  
  for (const [key, value] of entries) {
    const regex = new RegExp(`vs\\.\\s*${key}[:,]?`, 'i');
    if (regex.test(headerLine)) {
      return value;
    }
    const regexFull = new RegExp(`vs\\.\\s*${value}[:,]?`, 'i');
    if (regexFull.test(headerLine)) {
      return value;
    }
  }

  return null;
};


// Formats the lineup with numbered batting order
const formatLineup = (text) => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');

  // Extract player lines (first 9 lines)
  const playerLines = lines.slice(1, 10);
  const pitcherLine = lines.find((line) => line.toLowerCase().startsWith('sp:'));
  const startTimeLine = lines.find((line) => line.toLowerCase().startsWith('start time:'));

  const formattedPlayers = playerLines.map((line, index) => {
    // Extracts player name and position
    const parts = line.split(',');
    const name = parts[0].replace(/^\d+\.\s*/, '').trim();
    const position = parts[1] ? parts[1].trim() : '';
    return `${index + 1}. ${name} - ${position}`;
  });

  let formatted = `${formattedPlayers.join('\n')}\n\n`;
  if (pitcherLine) {
    formatted += `${pitcherLine}\n\n`;
  }
  if (startTimeLine) {
    formatted += `${startTimeLine}`;
  }

  return formatted;
};



// Formats the game start time to include ET and PT
// uses luxon
const formatGameTime = (text) => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const startTimeLine = lines.find((line) =>
    line.toLowerCase().trim().startsWith('start time:')
  );

  if (startTimeLine) {
    const timeMatch = startTimeLine.match(/start time:\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (timeMatch) {
      let [, hour, minute, ampm] = timeMatch;
      hour = parseInt(hour);
      minute = parseInt(minute);
      ampm = ampm.toLowerCase();

      const eastern = DateTime.fromObject(
        {
          hour: ampm === 'pm' && hour !== 12 ? hour + 12 : hour,
          minute: minute,
        },
        { zone: 'America/New_York' }
      );

      const pacific = eastern.setZone('America/Los_Angeles');

      const format = (dt) => dt.toFormat('h:mma').toLowerCase();

      return `Game Time: ${format(eastern)} ET, ${format(pacific)} PT`;
    }
  }
  return '';
};



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
      limit: 10,
    });

    for (const post of feed.data.feed) {
      // Converts post text to lowercase for keyword matching
      const text = post.post.record.text.toLowerCase();
      const cid = post.post.cid;

      // Checks if post contains any alert keywords
      const isAlertPost = alertKeywords.some((word) => text.includes(word));

      // If post matches alert criteria and hasn't been processed yet
      if (isAlertPost && !seenPosts.has(cid)) {
        const message = `🚨 Game Update 🚨\n\n${post.post.record.text}\n\n----------------------\n\n`;

        // Adds post to seenPosts and saves to disk
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);

        // Sends to Discord if in production, logs to console if local
        await postToDiscord(message);
      }
    }
  } catch (error) {
    console.error('Error fetching game alerts feed:', error);
  }

  // Schedule the next game alerts feed poll after delay (4 minutes)
  setTimeout(pollGameAlerts, POLL_ALERTS_INTERVAL);
};






init();