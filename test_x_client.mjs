import { TwitterClient } from './server/utils/twitter-client.js';

const client = new TwitterClient({ cookiePath: './twitter_cookies.json' });
await client.init();

console.log('\n=== TwitterClient Full Integration Test ===\n');

// Test 1: isAuthenticated
console.log('--- isAuthenticated ---');
const auth = await client.isAuthenticated();
console.log(auth ? '✅ Authenticated' : '❌ Not authenticated');

// Test 2: getTrends
console.log('\n--- getTrends ---');
try {
  const trends = await client.getTrends();
  console.log(`✅ ${trends.length} trends. Top 5:`);
  for (const t of trends.slice(0, 5)) {
    const vol = t.tweetVolume ? ` (${t.tweetVolume.toLocaleString()} tweets)` : '';
    console.log(`  • ${t.name}${vol}`);
  }
} catch (e) { console.error('❌', e.message); }

// Test 3: search
console.log('\n--- search (Latest) ---');
try {
  const tweets = await client.search('javascript', 5, 'Latest');
  console.log(`✅ ${tweets.length} tweets:`);
  for (const t of tweets.slice(0, 3)) {
    console.log(`  @${t.user?.username || t.user?.id || '?'}: ${t.text.substring(0, 70)}`);
    console.log(`    ❤️${t.likes} 🔁${t.retweets} 💬${t.replies} 👁${t.views}`);
  }
} catch (e) { console.error('❌', e.message); }

// Test 4: search (Top)
console.log('\n--- search (Top) ---');
try {
  const tweets = await client.search('AI news', 3, 'Top');
  console.log(`✅ ${tweets.length} tweets:`);
  for (const t of tweets.slice(0, 3)) {
    console.log(`  @${t.user?.username || t.user?.id || '?'}: ${t.text.substring(0, 70)}`);
    console.log(`    ❤️${t.likes} 🔁${t.retweets}`);
  }
} catch (e) { console.error('❌', e.message); }

// Test 5: getProfile
console.log('\n--- getProfile (elonmusk) ---');
try {
  const p = await client.getProfile('elonmusk');
  console.log(`✅ ${p.name} (@${p.username})`);
  console.log(`  Followers: ${p.followers?.toLocaleString()} | Following: ${p.following?.toLocaleString()}`);
  console.log(`  Tweets: ${p.tweets?.toLocaleString()} | Verified: ${p.verified}`);
  console.log(`  Created: ${p.createdAt?.toISOString()}`);
} catch (e) { console.error('❌', e.message); }

// Test 6: getProfile (smaller account)
console.log('\n--- getProfile (nodejs) ---');
try {
  const p = await client.getProfile('nodejs');
  console.log(`✅ ${p.name} (@${p.username})`);
  console.log(`  Followers: ${p.followers?.toLocaleString()} | Tweets: ${p.tweets?.toLocaleString()}`);
} catch (e) { console.error('❌', e.message); }

// Test 7: getUserTweets
console.log('\n--- getUserTweets ---');
try {
  // Use Elon's user ID (from getProfile)
  const tweets = await client.getUserTweets('44196397', 3);
  console.log(`✅ ${tweets.length} tweets from @elonmusk:`);
  for (const t of tweets.slice(0, 2)) {
    console.log(`  ${t.text.substring(0, 70)}`);
    console.log(`    ❤️${t.likes} 🔁${t.retweets} 👁${t.views}`);
  }
} catch (e) { console.error('❌', e.message); }

console.log('\n=== All tests complete ===');
