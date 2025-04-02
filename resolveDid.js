import { AtpAgent } from '@atproto/api';

const handle = 'fantasymlbnews.bsky.social';
//did: did:plc:hew2wmghmlzbeeqfwjfidv7j
//const handle = 'lineupbot.bsky.social';
// did: did:plc:d4r7rc7hj4fbkseqyzunyopn

const agent = new AtpAgent({ service: 'https://bsky.social' });

async function resolveDid(handle) {
  try {
    const response = await agent.resolveHandle({ handle });
    console.log(`DID for ${handle}: ${response.data.did}`);
  } catch (error) {
    console.error('Error resolving DID:', error);
  }
}