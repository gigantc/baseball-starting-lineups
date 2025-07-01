import { DateTime } from 'luxon';
import { teamAbbreviations } from './teamMap.js';





// Extracts and formats lineup header to "**Team**: M/D"
export const getFormattedHeader = (headerLine) => {
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
export const getOpponent = (headerLine) => {
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
export const formatLineup = (text) => {
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
// return looks like this: Game Time: 10:10pm ET  |  7:10pm PT
export const formatGameTime = (isoString) => {
  const eastern = DateTime.fromISO(isoString, { zone: 'America/New_York' });
  const pacific = eastern.setZone('America/Los_Angeles');

  const format = (dt) => dt.toFormat('h:mma').toLowerCase();

  return `${format(eastern)} ET | ${format(pacific)} PT`;
};
