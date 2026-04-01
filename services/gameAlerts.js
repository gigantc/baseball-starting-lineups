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

const POSITIVE_RULES = [
  {
    type: 'Lineup Alert',
    patterns: [
      'scratched',
      'removed from the lineup',
      'not in the lineup',
      'out of the lineup',
      'lineup change',
      'late lineup change',
      'will start in place of',
      'batting leadoff',
      'leading off',
      'starting at',
    ],
  },
  {
    type: 'Injury Alert',
    patterns: [
      'placed on the il',
      'placed on il',
      '10-day il',
      '15-day il',
      '7-day il',
      'surprise il',
      'day-to-day',
      'left today',
      'left the game',
      'x-rays',
      'mri',
      'will miss',
      'out today',
      'not starting today',
    ],
  },
  {
    type: 'Game Alert',
    patterns: [
      'postponed',
      'delayed',
      'start time has changed',
      'first pitch has been moved',
      'weather delay',
      'starter has changed',
      'will start for',
    ],
  },
  {
    type: 'Status Alert',
    patterns: [
      'activated from the il',
      'activated off the il',
      'optioned',
      'designated for assignment',
      'recalled',
      'called up',
    ],
  },
];

const NEGATIVE_PATTERNS = [
  'homered',
  'home run',
  '2-run hr',
  '3-run hr',
  'grand slam',
  'walk-off',
  'last season',
  'fwar',
  'video',
  'watch:',
  'watch ',
  'highlight',
  'highlights',
  'recap',
  'extension',
  'signed',
  'deal',
  'rumor',
  'interview',
  'quote',
  'spring breakout',
  'top prospect',
  'opening day starter',
];

const classifyPost = (text) => {
  if (NEGATIVE_PATTERNS.some((pattern) => text.includes(pattern))) {
    return null;
  }

  for (const rule of POSITIVE_RULES) {
    const matchedPattern = rule.patterns.find((pattern) => text.includes(pattern));
    if (matchedPattern) {
      return {
        type: rule.type,
        matchedPattern,
      };
    }
  }

  return null;
};

export const pollGameAlerts = async () => {
  try {
    const feed = await agent.api.app.bsky.feed.getAuthorFeed({
      actor: 'insidemlbnews.bsky.social',
      limit: 20,
    });

    for (const post of feed.data.feed) {
      const originalText = post.post.record.text || '';
      const text = originalText.toLowerCase();
      const cid = post.post.cid;

      if (seenPosts.has(cid)) {
        continue;
      }

      const classification = classifyPost(text);
      if (!classification) {
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);
        continue;
      }

      const message = `🚨 ${classification.type} 🚨\n\n${originalText}\n\n----------------------\n\n`;

      seenPosts.add(cid);
      saveSeenPosts(seenPosts);

      await postToDiscord(message);
      break;
    }
  } catch (error) {
    console.error('Error fetching game alerts feed:', error);
  }
};
