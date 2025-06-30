//////////////////////////////////////////
// Used to save/load game and post data





// Loads seen post IDs from disk if available
export const loadSeenPosts = () => {
  try {
    const data = fs.readFileSync(SEEN_POSTS_FILE, 'utf-8');
    const json = JSON.parse(data);
    return new Set(json.posts);
  } catch (error) {
    return new Set();
  }
};





// Saves seen post IDs to disk (limits to last 50 posts)
export const saveSeenPosts = (set) => {
  const maxPosts = 50;
  const postsArray = Array.from(set);
  const limitedPosts = postsArray.slice(-maxPosts);
  const json = { posts: limitedPosts };
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(json, null, 2));
};