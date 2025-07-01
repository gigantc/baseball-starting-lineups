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
export const buildLineup = (teamData, playersData) => {
  const battingOrder = teamData?.battingOrder;

  if (battingOrder && battingOrder.length > 0) {
    return battingOrder.map((playerId, idx) => {
      const player = playersData[`ID${playerId}`];
      return {
        order: idx + 1,
        name: player?.person?.fullName,
        position: player?.position?.abbreviation,
      };
    });
  }

  return null;
};



// Formats the game start time to include ET and PT
// uses luxon
// return looks like this: Game Time: 10:10pm ET  |  7:10pm PT
export const formatGameTime = (isoString) => {
  const eastern = DateTime.fromISO(isoString, { zone: 'America/New_York' });
  const pacific = eastern.setZone('America/Los_Angeles');

  const format = (dt) => dt.toFormat('h:mma').toLowerCase();

  return `${format(eastern)} ET, ${format(pacific)} PT`;
};
