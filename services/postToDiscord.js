import dotenv from 'dotenv';
dotenv.config();


const isProduction = process.env.ENVIRONMENT === 'production';
const discordEnabled = process.env.DISCORD_ENABLED !== 'false';


export const postToDiscord = async (message) => {
  if (!discordEnabled) {
    console.log(`[discord disabled] ${message.trim().split('\n')[0]}`);
    return;
  }

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