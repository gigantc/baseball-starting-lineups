import dotenv from 'dotenv';
dotenv.config();
import { AtpAgent } from '@atproto/api';

import { postToDiscord } from '../services/postToDiscord.js';
import { loadSeenPosts, saveSeenPosts } from '../utils/storage.js';
const seenPosts = loadSeenPosts();



const agent = new AtpAgent({ service: 'https://bsky.social' });
await agent.login({
  identifier: process.env.BSKY_IDENTIFIER,
  password: process.env.BSKY_APP_PASSWORD,
});


//we only want alert posts that start with this, so we'll filter them out
const alertKeywords = ['game alert', 'lineup alert', 'postponed', 'weather', 'scratched'];

//watching keywords to potentailly add news later
const newsKeywords = ['Hyde', 'Passan', 'Feinsand', 'Rosenthal', 'Weyrich', 'Murray', 'Francona', 'Roberts', 'Friedman', 'per', 'Boone', 'Espada', 'McCullough'];


// Grabs the Bluesky feed and processes posts
// this is for REALTIME GAME ALERTS
export const pollGameAlerts = async () => {
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
};