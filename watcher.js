import dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import { AtpAgent } from '@atproto/api';

const agent = new AtpAgent({ service: 'https://bsky.social' });
 // Poll every 60 seconds
const POLL_INTERVAL = 60000;


//////////////////////////////////////////
// Keywords and Filtering

// this is a list of keywords that will become part of the filter
const extraKeywords = ['game alert', 'lineup alert'];
//keeps track of posts that have already been logged
const seenPosts = new Set();

// this will filter out todays date to pull the posted lineups.
//ex. Cubs 3/28
const getTodayPattern = () => {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const datePattern = `${month}/${day}`;
  // Matches one or more capitalized words followed by today's date
  return new RegExp(`^([A-Z][a-z]+\\s?)+${datePattern}`);
}



const init = async () => {
  try {
    await agent.login({
      identifier: process.env.BSKY_IDENTIFIER,
      password: process.env.BSKY_APP_PASSWORD,
    });
    // console.log('✅ Logged in to Bluesky');
    // Call pollFeed once after login
    await pollFeed();
  } catch (error) {
    console.error('Error logging in to Bluesky:', error);
  }
}


//////////////////////////////////////////
// Grabs the data from the feed and displays it.
const pollFeed = async () => {
  // Fetches the latest posts from the target Bluesky account.

  try {
    const feed = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: 'fantasymlbnews.bsky.social',
      limit: 10,
    });

    for (const post of feed.data.feed) {
      // Extracts text, uri, and cid from each post.
      const text = post.post.record.text.toLowerCase();
      const rkey = post.post.uri.split('/').pop();
      const uri = `https://bsky.app/profile/fantasymlbnews.bsky.social/post/${rkey}`;
      const cid = post.post.cid;
      const mlbPattern = getTodayPattern();
      const matches = mlbPattern.test(post.post.record.text);
      const keywordMatch = extraKeywords.some((word) =>
        post.post.record.text.toLowerCase().includes(word)
      );

      if ((matches || keywordMatch) && !seenPosts.has(cid)) {
        const message = `----------------------\n🚨 MLB Lineup Alert 🚨:\n\n${post.post.record.text}\n----------------------\n`;
        console.log(message);

        // Adds the post's cid to the seenPosts Set so it won't be logged again.
        seenPosts.add(cid);

        if (process.env.DISCORD_WEBHOOK_URL) {
          await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message }),
          });
        }
      }
    }
  } catch (error) {
    console.error('Error fetching feed:', error);
  }

  // Schedules the next feed poll after a delay
  setTimeout(pollFeed, POLL_INTERVAL);
}

init();