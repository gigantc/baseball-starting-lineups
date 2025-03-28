import { AtpAgent } from '@atproto/api';

const handle = 'fantasymlbnews.bsky.social';

const agent = new AtpAgent({ service: 'https://bsky.social' });

async function resolveDid(handle) {
  try {
    const response = await agent.resolveHandle({ handle });
    console.log(`DID for ${handle}: ${response.data.did}`);
  } catch (error) {
    console.error('Error resolving DID:', error);
  }
}

resolveDid(handle);