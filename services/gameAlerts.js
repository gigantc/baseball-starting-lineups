import dotenv from 'dotenv';
dotenv.config();
import { AtpAgent } from '@atproto/api';

import { postToDiscord } from '../services/postToDiscord.js';
import { refreshLineupFromAlert } from '../services/mlbGames.js';
import { loadSeenPosts, saveSeenPosts } from '../utils/storage.js';
const seenPosts = loadSeenPosts();

const agent = new AtpAgent({ service: 'https://bsky.social' });
await agent.login({
  identifier: process.env.BSKY_IDENTIFIER,
  password: process.env.BSKY_APP_PASSWORD,
});

const POSITIVE_RULES = [
  {
    type: 'Game Alert',
    patterns: [
      'game alert',
      'postponed',
      'delayed',
      'inclement weather',
      'weather delay',
      'expected to start at',
      'start time has changed',
      'first pitch has been moved',
    ],
  },
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
      'will open',
      'bullpen game',
      'opener',
    ],
  },
  {
    type: 'Injury Alert',
    patterns: [
      'status alert',
      'leaves game',
      'leaves with trainer',
      'with trainer',
      'exits game',
      'left the game',
      'left today',
      'after being hit by',
      'day-to-day',
      'x-rays',
      'mri',
      'will miss',
      'out today',
      'not starting today',
      'expected to make next start',
      'expected to start',
      'will start for',
      'will start',
      'forearm',
      'hand',
      'hamstring',
      'oblique',
      'shoulder',
      'elbow',
      'neck',
      'leg',
      'back',
      'personal',
    ],
  },
  {
    type: 'Status Alert',
    patterns: [
      'activated from the il',
      'activated off the il',
      'placed on the il',
      'placed on il',
      '10-day il',
      '15-day il',
      '7-day il',
      'surprise il',
      'optioned',
      'optioned to triple-a',
      'selected to active roster',
      'designated for assignment',
      'recalled',
      'called up',
      'rotation',
      '6-man rotation',
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

const LINEUP_POST_PATTERNS = [
  /^\w+[\w\s.-]*\s\d{1,2}\/\d{1,2}/m,
  /\bsp\b/m,
];

const LINEUP_POSITION_COUNT_PATTERN = /\b(?:c|1b|2b|3b|ss|lf|cf|rf|dh|sp)\b/g;

const looksLikeStandardLineupPost = (text) => {
  const hasHeader = LINEUP_POST_PATTERNS[0].test(text);
  const hasStarter = LINEUP_POST_PATTERNS[1].test(text);
  const positionCount = (text.match(LINEUP_POSITION_COUNT_PATTERN) || []).length;

  return (hasHeader && hasStarter) || positionCount >= 8;
};

const extractUpdatedLineupHeader = (originalText) => {
  const firstLine = originalText.split('\n')[0]?.trim();
  const match = firstLine?.match(/^Updated\s+(.+?)\s+(\d{1,2}\/\d{1,2})$/i);
  if (!match) return null;

  return {
    teamLabel: match[1].trim(),
    dateLabel: match[2],
  };
};

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

  if (looksLikeStandardLineupPost(text)) {
    return null;
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

      const updatedLineup = extractUpdatedLineupHeader(originalText);
      if (updatedLineup) {
        const postedUpdate = await refreshLineupFromAlert(updatedLineup.teamLabel, updatedLineup.dateLabel);
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);

        if (postedUpdate) {
          break;
        }

        continue;
      }

      const classification = classifyPost(text);
      if (!classification) {
        seenPosts.add(cid);
        saveSeenPosts(seenPosts);
        continue;
      }

      const message = `🚨 News Alert 🚨\n\n${originalText}\n\n----------------------\n\n`;

      seenPosts.add(cid);
      saveSeenPosts(seenPosts);

      await postToDiscord(message);
      break;
    }
  } catch (error) {
    console.error('Error fetching game alerts feed:', error);
  }
};
