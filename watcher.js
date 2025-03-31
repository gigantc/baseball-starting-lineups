import dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import fs from 'fs';
import { AtpAgent } from '@atproto/api';



//////////////////////////////////////////
// Constants
const isProduction = process.env.ENVIRONMENT === 'production';
const POLL_INTERVAL = 60000; // Poll every 60 seconds
const SEEN_POSTS_FILE = './seen-posts.json';

const teamNames = [
  'Blue Jays', 'Yankees', 'Red Sox', 'Orioles', 'Rays',
  'White Sox', 'Guardians', 'Tigers', 'Royals', 'Twins',
  'Astros', 'Mariners', 'Rangers', 'Angels', 'Athletics',
  'Braves', 'Marlins', 'Mets', 'Phillies', 'Nationals',
  'Cubs', 'Reds', 'Brewers', 'Pirates', 'Cardinals',
  'Diamondbacks', 'Rockies', 'Dodgers', 'Padres', 'Giants'
];

//post can come through looking like this that are not lineups
const extraKeywords = ['game alert', 'lineup alert'];




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

// Saves seen post IDs to disk (limits to last 200 posts)
const saveSeenPosts = (set) => {
  const maxPosts = 200;
  const postsArray = Array.from(set);
  const limitedPosts = postsArray.slice(-maxPosts);
  const json = { posts: limitedPosts };
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(json, null, 2));
};

// Builds a regex pattern to match today's date lineup posts
const getTodayPattern = () => {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const datePattern = `${month}/${day}`;
  return new RegExp(`^([A-Z][a-z]+\\s?)+${datePattern}`);
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
    await pollFeed();
  } catch (error) {
    console.error('Error logging in to Bluesky:', error);
  }
};

// Polls the Bluesky feed and processes posts
const pollFeed = async () => {
  try {
    const feed = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: 'fantasymlbnews.bsky.social',
      limit: 10,
    });

    for (const post of feed.data.feed) {
      const text = post.post.record.text.toLowerCase();
      const cid = post.post.cid;
      const todayPattern = getTodayPattern();
      const isLineupPost = todayPattern.test(post.post.record.text);
      const isKeywordPost = extraKeywords.some((word) => text.includes(word));

      const firstLine = post.post.record.text.split('\n')[0];
      const teamName = teamNames.find((name) => firstLine.startsWith(name));

      let formattedText = post.post.record.text;
      if (teamName) {
        formattedText = post.post.record.text.replace(teamName, `**${teamName}**`);
      }

      if ((isLineupPost || isKeywordPost) && !seenPosts.has(cid)) {
        const alertType = isLineupPost ? '⚾️ New Lineup Released' : '🚨 Game Update 🚨';
        const message = `${alertType}:\n${formattedText}\n----------------------\n`;

        seenPosts.add(cid);
        saveSeenPosts(seenPosts);

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
      }
    }
  } catch (error) {
    console.error('Error fetching feed:', error);
  }

  // Schedule the next feed poll after delay
  setTimeout(pollFeed, POLL_INTERVAL);
};

init();