/**
 * Reddit r/all Top Posters Tracker
 * Tracks the top 1000 posters on Reddit's r/all daily
 */

interface UserData {
	username: string;
	post_count: number;
	comment_count: number;
	comment_score?: number;
	total_karma: number;
	first_seen: string;
	last_updated: number;
	daily_posts: Record<string, number>;
	daily_comments?: Record<string, number>;
	subreddits?: Record<string, number>; // Track where they post
	comment_subreddits?: Record<string, number>;
	domains?: Record<string, number>;    // Track what sources they push (critical for shill detection)
	hourly_posts?: Record<string, number>; // UTC hour bucket counts for cadence analysis
	hourly_comments?: Record<string, number>;
	post_types?: Record<string, number>; // self/link/image/video/gallery/crosspost mix
	urls?: Record<string, number>;
	profile?: UserProfile;
  }

  interface UserProfile {
	created_utc?: number;
	link_karma?: number;
	comment_karma?: number;
	is_mod?: boolean;
	is_gold?: boolean;
	has_verified_email?: boolean;
  }

  interface TopUser {
	rank: number;
	username: string;
	post_count: number;
	total_karma: number;
	first_seen: string;
	daily_average: number;
	top_subreddit: string; // Most frequent subreddit
  }

  interface TopPostersResponse {
	date: string;
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
	users: TopUser[];
  }

  interface ProfileSnapshotStats {
	count: number;
	first_ts: number | null;
	last_ts: number | null;
	delta_link_karma: number | null;
	delta_comment_karma: number | null;
  }

  interface UrlReuseStats {
	distinct_urls: number;
	shared_urls: number;
	shared_url_ratio: number;
  }

  interface UserResponse {
	username: string;
	post_count: number;
	comment_count: number;
	comment_score?: number;
	total_karma: number;
	first_seen: string;
	last_updated: string;
	daily_average: number;
	recent_activity: Record<string, number>;
	recent_comments?: Record<string, number>;
	subreddits?: Record<string, number>;
	comment_subreddits?: Record<string, number>;
	domains?: Record<string, number>;
	hourly_posts?: Record<string, number>;
	hourly_comments?: Record<string, number>;
	post_types?: Record<string, number>;
	urls?: Record<string, number>;
	profile?: UserProfile;
	profile_snapshots?: ProfileSnapshotStats;
	url_reuse?: UrlReuseStats;
  }

  interface StatsResponse {
	total_users: number;
	top_count: number;
	collection_status: string;
	last_collection: string | null;
	date: string;
	system: string;
  }

  interface CommentCollectionResult {
	users_processed: number;
	comments_fetched: number;
	comments_processed: number;
  }

  interface Env {
	// KV namespaces
	REDDIT_USERS: KVNamespace;
	REDDIT_POSTS: KVNamespace;
	REDDIT_TOP_LISTS: KVNamespace;
	REDDIT_CONFIG: KVNamespace;
	// D1 Database for chunking/coordination research
	DB: D1Database;
	// Cloudflare Workers AI
	AI: any; 
	// Cloudflare Vectorize
	VECTORIZE: VectorizeIndex;
	// Optional secrets
	OPENAI_API_KEY?: string;
  }

  // Import chunking modules
  import {
	D1ChunkingDatabase,
	ChunkingPipeline,
	createEmbeddingProvider,
	DEFAULT_CHUNK_CONFIG
  } from './chunking';
  import type { RawItem } from './chunking';

  // Configuration
  const REDDIT_API = 'https://www.reddit.com';
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) reddit-tracker-bot/1.0 (contact: paulchrisluke@example.com)';
  const CACHE_TTL = 3600; // 1 hour
  const KV_TTL = 30 * 86400; // 30 days
  const MAX_POSTS_PER_DAY = 500; // Increased for better sampling (constrained by KV limits)
  const MAX_USER_ITEMS = 200; // Safety cap for manual user collection
  const MAX_USER_PAGES = 5;
  const MAX_URLS_PER_USER = 200;
  const COMMENT_SEED_BATCH = 6;
  const COMMENT_SEED_LIMIT = 40;
  const COMMENT_SEED_PAGES = 1;
  const EMBEDDINGS_CRON = '0 3 * * *';

  export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	  const url = new URL(request.url);
	  const path = url.pathname;

	  // API endpoints
	  if (path === '/api/top-posters') {
		return await handleTopPosters(request, env);
	  }

	  if (path === '/api/user') {
		return await handleUserSearch(request, env);
	  }

	  if (path === '/api/stats') {
		return await handleStats(env);
	  }

	  if (path === '/api/trigger') {
		// Synchronous trigger - waits for completion and returns results
		try {
		  const result = await collectData(env);
		  return jsonResponse({ status: 'completed', ...result });
		} catch (error) {
		  return jsonResponse({ status: 'error', message: error instanceof Error ? error.message : String(error) }, 500);
		}
	  }

	  if (path === '/api/trigger-async') {
		// Async trigger - returns immediately (may timeout on free tier)
		ctx.waitUntil(collectData(env));
		return jsonResponse({ status: 'started', warning: 'Background task may timeout on free tier. Use /api/trigger for synchronous collection.' });
	  }

  if (path === '/api/collect-user') {
		return await handleCollectUser(request, env);
	  }

	  if (path === '/api/review/enqueue') {
		return await handleReviewEnqueue(request, env);
	  }

	  if (path === '/api/review/next') {
		return await handleReviewNext(request, env);
	  }

	  if (path === '/api/review/submit') {
		return await handleReviewSubmit(request, env);
	  }

	  if (path === '/api/trigger-chunking') {
		try {
			const url = new URL(request.url);
			const allowEmbeddings = url.searchParams.get('embeddings') === 'true';
			const result = await runChunkingPipeline(env, { allowEmbeddings });
			return jsonResponse({ status: 'completed', result });
		} catch (error) {
			return jsonResponse({ status: 'error', message: error instanceof Error ? error.message : String(error) }, 500);
		}
	  }

	  if (path === '/api/test-chunking-logic') {
		const { runChunkingTests } = await import('./chunking/tests');
		const result = await runChunkingTests();
		return jsonResponse(result);
	  }

	  // Health check endpoint
	  if (path === '/health') {
		await env.REDDIT_CONFIG.put('test_key', 'test_value');
		const val = await env.REDDIT_CONFIG.get('test_key');
		return jsonResponse({ status: 'healthy', kv_test: val === 'test_value' ? 'ok' : 'fail', timestamp: new Date().toISOString() });
	  }

	  // Research paper endpoint
	  if (path === '/RESEARCH.md') {
		const html = `
		<!DOCTYPE html>
		<html lang="en">
		<head>
		  <title>The Concentration of Content Creation on Reddit</title>
		  <meta charset="UTF-8">
		  <meta name="viewport" content="width=device-width, initial-scale=1.0">
		  <style>
			body {
			  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			  line-height: 1.6;
			  max-width: 800px;
			  margin: 0 auto;
			  padding: 40px 20px;
			  color: #333;
			  background: #f9f9f9;
			}
			h1, h2, h3 { color: #111; margin-top: 1.5em; }
			h1 { border-bottom: 2px solid #FF5700; padding-bottom: 0.3em; }
			code, pre { background: #eee; padding: 0.2em 0.4em; border-radius: 3px; font-family: monospace; }
			pre { padding: 1em; overflow-x: auto; }
			blockquote { border-left: 4px solid #FF5700; margin: 0; padding-left: 1em; color: #666; }
			img { max-width: 100%; }
			a { color: #FF5700; text-decoration: none; }
			a:hover { text-decoration: underline; }
		  </style>
		</head>
		<body>
		  <!-- Simple Markdown Rendering -->
		  ${RESEARCH_PAPER
			.replace(/^# (.*$)/gm, '<h1>$1</h1>')
			.replace(/^## (.*$)/gm, '<h2>$1</h2>')
			.replace(/^### (.*$)/gm, '<h3>$1</h3>')
			.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
			.replace(/`(.*?)`/g, '<code>$1</code>')
			.replace(/\n\n/g, '<br><br>')
			.replace(/^- (.*$)/gm, '<li>$1</li>')
		  }
		  <br><br>
		  <hr>
		  <p style="text-align: center;"><a href="/">← Back to Tracker</a></p>
		</body>
		</html>
		`;
		return new Response(html, { headers: { 'Content-Type': 'text/html' } });
	  }

	  if (path === '/game') {
		return new Response(renderGamePage(), { headers: { 'Content-Type': 'text/html' } });
	  }

	  // Default response with research-focused homepage
	  return new Response(`
		<!DOCTYPE html>
		<html lang="en">
		<head>
		  <title>Reddit Top Posters Tracker | Open Research Project</title>
		  <meta charset="UTF-8">
		  <meta name="viewport" content="width=device-width, initial-scale=1.0">
		  <meta name="description" content="Open-source research tracking content concentration and account-level signals on Reddit's front page, with a focus on detecting coordinated or promotional posting behavior.">
		  <link rel="preconnect" href="https://fonts.googleapis.com">
		  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
		  <style>
			* { box-sizing: border-box; margin: 0; padding: 0; }
			body {
			  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			  background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
			  min-height: 100vh;
			  color: #e0e0e0;
			  line-height: 1.7;
			}
			.container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; }
			
			/* Hero Section */
			.hero {
			  text-align: center;
			  padding: 60px 0;
			  border-bottom: 1px solid rgba(255,87,0,0.2);
			}
			.hero h1 {
			  font-size: 2.8rem;
			  font-weight: 700;
			  background: linear-gradient(135deg, #FF5700 0%, #FF8C00 100%);
			  -webkit-background-clip: text;
			  -webkit-text-fill-color: transparent;
			  background-clip: text;
			  margin-bottom: 15px;
			}
			.hero .tagline {
			  font-size: 1.3rem;
			  color: #a0a0a0;
			  max-width: 600px;
			  margin: 0 auto 30px;
			}
			.badge {
			  display: inline-block;
			  background: rgba(255,87,0,0.15);
			  border: 1px solid rgba(255,87,0,0.3);
			  color: #FF8C00;
			  padding: 6px 14px;
			  border-radius: 20px;
			  font-size: 0.85rem;
			  margin: 5px;
			}
			
			/* Stats Banner */
			.stats-banner {
			  display: grid;
			  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			  gap: 20px;
			  margin: 40px 0;
			}
			.stat-card {
			  background: rgba(255,255,255,0.03);
			  border: 1px solid rgba(255,255,255,0.08);
			  border-radius: 12px;
			  padding: 25px;
			  text-align: center;
			  transition: transform 0.2s, border-color 0.2s;
			}
			.stat-card:hover {
			  transform: translateY(-3px);
			  border-color: rgba(255,87,0,0.3);
			}
			.stat-card .number {
			  font-size: 2.5rem;
			  font-weight: 700;
			  color: #FF5700;
			}
			.stat-card .label {
			  color: #888;
			  font-size: 0.9rem;
			  margin-top: 5px;
			}
			
			/* Research Section */
			.section {
			  margin: 50px 0;
			  padding: 30px;
			  background: rgba(255,255,255,0.02);
			  border-radius: 16px;
			  border: 1px solid rgba(255,255,255,0.05);
			}
			.section h2 {
			  font-size: 1.6rem;
			  color: #fff;
			  margin-bottom: 20px;
			  display: flex;
			  align-items: center;
			  gap: 10px;
			}
			.section h2::before {
			  content: '';
			  width: 4px;
			  height: 24px;
			  background: #FF5700;
			  border-radius: 2px;
			}
			
			/* Hypothesis Box */
			.hypothesis {
			  background: linear-gradient(135deg, rgba(255,87,0,0.1) 0%, rgba(255,140,0,0.05) 100%);
			  border-left: 4px solid #FF5700;
			  padding: 25px;
			  border-radius: 0 12px 12px 0;
			  margin: 20px 0;
			}
			.hypothesis p {
			  font-size: 1.15rem;
			  font-style: italic;
			  color: #ddd;
			}
			
			/* API Endpoints */
			.endpoints {
			  display: grid;
			  gap: 15px;
			}
			.endpoint {
			  background: rgba(0,0,0,0.2);
			  border: 1px solid rgba(255,255,255,0.08);
			  border-radius: 10px;
			  padding: 20px;
			  display: flex;
			  justify-content: space-between;
			  align-items: center;
			  flex-wrap: wrap;
			  gap: 15px;
			}
			.endpoint code {
			  background: rgba(255,87,0,0.15);
			  color: #FF8C00;
			  padding: 8px 14px;
			  border-radius: 6px;
			  font-family: 'Monaco', 'Consolas', monospace;
			  font-size: 0.9rem;
			}
			.endpoint .desc {
			  flex: 1;
			  min-width: 200px;
			}
			.endpoint a {
			  color: #FF5700;
			  text-decoration: none;
			  font-weight: 500;
			}
			.endpoint a:hover { text-decoration: underline; }
			
			/* CTA Button */
			.cta {
			  display: inline-block;
			  background: linear-gradient(135deg, #FF5700 0%, #FF8C00 100%);
			  color: white;
			  padding: 14px 28px;
			  border-radius: 8px;
			  text-decoration: none;
			  font-weight: 600;
			  transition: transform 0.2s, box-shadow 0.2s;
			  margin: 10px 5px;
			}
			.cta:hover {
			  transform: translateY(-2px);
			  box-shadow: 0 10px 30px rgba(255,87,0,0.3);
			}
			.cta.secondary {
			  background: transparent;
			  border: 2px solid #FF5700;
			}
			
			/* Footer */
			footer {
			  text-align: center;
			  padding: 40px 0;
			  color: #666;
			  font-size: 0.9rem;
			}
			footer a { color: #FF5700; text-decoration: none; }
			footer a:hover { text-decoration: underline; }
			
			/* Lists */
			ul { padding-left: 20px; }

		  </style>
		</head>
		<body>
		  <div class="container">
			<div class="hero">
			  <h1>Reddit Top Posters Tracker</h1>
			  <p class="tagline">Tracking concentration and account-level signals for shill detection on Reddit's front page</p>
			  <div class="badge">Open Source Research</div>
			  <div style="margin-top: 20px;">
				<a href="/game" class="cta">Play “Is It An Ad?”</a>
			  </div>
			</div>

			<div class="stats-banner">
			  <div class="stat-card">
				<div class="number" id="total-users">--</div>
				<div class="label">Users Tracked (24h)</div>
			  </div>
			  <div class="stat-card">
				<div class="number" id="top-count">--</div>
				<div class="label">Top Lists Collected</div>
			  </div>
			</div>

    <section class="section">
      <h2>The Research Question</h2>
      
      <div style="margin: 30px 0; position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);">
        <iframe 
          style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;"
          src="https://www.youtube.com/embed/J7XOCG_P6o4" 
          title="YouTube video player" 
          frameborder="0" 
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
          allowfullscreen>
        </iframe>
      </div>

      <div class="hypothesis">
        <p>"To what extent is Reddit’s most visible content disproportionately produced by a small number of accounts, and what is the observable effect of removing them from a user’s experience?"</p>
      </div>

      <p>This project investigates structural content concentration on Reddit’s front page, particularly within the <code>r/all</code> aggregation feed.</p>
      <br>
      <p>Reddit allows users to block up to 1,000 accounts. We treat this ceiling as a parameter for measurement: if one were to block the 1,000 most prolific posters appearing on r/all, what measurable changes would occur in the composition of visible content? Would content diversity increase? Would narrative and tonal variation improve? Or would such filtering reveal further evidence of structural redundancy?</p>
      <br>
      <p>Beyond front-page concentration, we now profile accounts directly: post/comment cadence, subreddit and domain concentration, external URL reuse, and content-type mix. The goal is to build a labeled dataset that mirrors human judgment and train a model that can flag likely shill/astroturf behavior with the same intuition as a careful reader.</p>
      
      <h3 style="margin-top: 30px; margin-bottom: 15px; color: #fff;">Context & Theory</h3>
      <p>This research is motivated by longstanding discussions about the authenticity and organicity of content online. These include recent popular and academic interest in the <strong>"Dead Internet Theory"</strong> — the hypothesis that a significant and increasing proportion of internet content is generated by automation, coordination, or commercial influence, rather than by autonomous, unaffiliated individuals.</p>
      <br>
      <p>We do not attempt to prove or disprove this theory in broad terms. Instead, we operationalize a narrower set of testable questions within the Reddit ecosystem:</p>
      
      <ul style="margin: 20px 0 20px 20px; color: #ccc;">
        <li style="margin-bottom: 10px;">What proportion of front-page visibility is accounted for by how few users?</li>
        <li style="margin-bottom: 10px;">How stable is this cohort over time?</li>
        <li style="margin-bottom: 10px;">Can high-frequency front-page appearances be attributed to user behavior alone, or are they suggestive of amplification, coordination, or platform affordances?</li>
        <li style="margin-bottom: 10px;">What kinds of content emerge — or fail to emerge — when these users are excluded?</li>
      </ul>

      <p>The project draws methodological inspiration from recent work in computational propaganda, visibility architectures, and information ecosystems. It also draws on informal pattern recognition expressed by Reddit users and independent researchers, who have observed recurring signals of inorganic behavior — including repetitive posting patterns, thematic consistency across accounts, and unusually rapid or uniform engagement on specific content.</p> 

      <h3 style="margin-top: 30px; margin-bottom: 15px; color: #fff;">methodology</h3>
      <p>To investigate these phenomena empirically, this project implements a continuous data collection pipeline using <strong>Cloudflare Workers</strong> to track the presence, volume, and distribution of top posters across Reddit’s front page. We then seed account histories to profile posting and comment behavior for detection modeling. All collected data is open and reproducible. The emphasis is on structure, distribution, and testable inference, rather than attribution or classification.</p>
      <br>
      <h3 style="margin-top: 30px; margin-bottom: 15px; color: #fff;">Account Profiling Signals</h3>
      <ul style="margin: 20px 0 20px 20px; color: #ccc;">
        <li style="margin-bottom: 10px;">Cadence: hourly posting/comment rhythms and active-day ratios.</li>
        <li style="margin-bottom: 10px;">Focus: subreddit and domain concentration (HHI), plus URL repetition.</li>
        <li style="margin-bottom: 10px;">Content mix: self/link/image/video/crosspost distributions.</li>
        <li style="margin-bottom: 10px;">Engagement profile: comment ratio and karma patterns.</li>
        <li style="margin-bottom: 10px;">Shared links: cross-account reuse of external URLs.</li>
      </ul>

    </section>

    <section class="section">
      <h2>Variables & Measurement</h2>
      <div class="tracking-grid">
        <div class="tracking-card">
          <div class="tracking-icon">📈</div>
          <h3>Volume & Reach</h3>
          <p>We measure how often distinct accounts place content onto <code>r/all</code>, establishing baseline "super-poster" frequency and volatility.</p>
        </div>
        <div class="tracking-card">
          <div class="tracking-icon">⏰</div>
          <h3>Cadence & Rhythm</h3>
          <p>We map posting and comment timestamps to detect uniform hour-of-day activity and active-day ratios.</p>
        </div>
        <div class="tracking-card">
          <div class="tracking-icon">📊</div>
          <h3>Content Mix</h3>
          <p>We track post types (self/link/image/video/crosspost) to distinguish distribution-style accounts from organic discussion.</p>
        </div>
        <div class="tracking-card">
          <div class="tracking-icon">🔗</div>
          <h3>Link Reuse</h3>
          <p>We normalize external URLs and measure reuse within and across accounts to flag coordinated promotion patterns.</p>
        </div>
        <div class="tracking-card">
          <div class="tracking-icon">💬</div>
          <h3>Engagement Profile</h3>
          <p>We capture comment ratios, karma balance, and subreddit mix to assess whether an account behaves like a participant or a broadcaster.</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>API Endpoints</h2>
      <div class="endpoints">
        <div class="endpoint">
          <code>GET /api/top-posters</code>
          <div class="desc">Get ranked list of top posters with pagination</div>
          <a href="/api/top-posters?limit=20" target="_blank" class="endpoint-link">Try it →</a>
        </div>
        <div class="endpoint">
          <code>GET /api/user?username=X</code>
          <div class="desc">Get detailed stats for a specific user (include=signals)</div>
          <a href="/api/user?username=example&include=signals,profile" target="_blank" class="endpoint-link">Try it →</a>
        </div>
        <div class="endpoint">
          <code>GET /api/collect-user?username=X</code>
          <div class="desc">Seed user submissions/comments for local analysis</div>
          <a href="/api/collect-user?username=example" target="_blank" class="endpoint-link">Run now →</a>
        </div>
        <div class="endpoint">
          <code>GET /api/stats</code>
          <div class="desc">System statistics and data collection status</div>
          <a href="/api/stats" target="_blank" class="endpoint-link">Try it →</a>
        </div>
        <div class="endpoint">
          <code>GET /api/trigger</code>
          <div class="desc">Manually trigger data collection</div>
          <a href="/api/trigger" target="_blank" class="endpoint-link">Run now →</a>
        </div>
      </div>
    </section>

    <section class="section" style="text-align: center;">
      <h2>Get Involved in the Research</h2>
      <p style="max-width: 800px; margin: 0 auto 25px;">This is an open-source project at the intersection of social media research and platform transparency. We welcome researchers, data scientists, developers, and anyone interested in labeling accounts or improving detection signals.</p>
      <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
        <a href="https://github.com/paulchrisluke/reddit-tracker" class="cta">
          <span style="display: inline-flex; align-items: center; gap: 8px;">
            <svg height="16" viewBox="0 0 16 16" width="16" style="fill: currentColor;">
              <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
            </svg>
            View on GitHub
          </span>
        </a>
        <a href="/RESEARCH.md" class="cta secondary">
          <span style="display: inline-flex; align-items: center; gap: 8px;">
            📄 Read the Full Paper
          </span>
        </a>
        <a href="https://github.com/paulchrisluke/reddit-tracker/issues" class="cta secondary">
          <span style="display: inline-flex; align-items: center; gap: 8px;">
            💡 Suggest Improvements
          </span>
        </a>
        <a href="/game" class="cta secondary">
          <span style="display: inline-flex; align-items: center; gap: 8px;">
            🎯 Play “Is It An Ad?”
          </span>
        </a>
      </div>
    </section>

    <footer>
      <p>Created by <a href="https://reddit.com/u/tankyspanky" target="_blank">u/tankyspanky</a> | 
         <a href="https://github.com/paulchrisluke/reddit-tracker" target="_blank">Open Source</a> | 
         <a href="https://github.com/paulchrisluke/reddit-tracker/blob/main/LICENSE" target="_blank">MIT License</a>
      </p>
      <p style="margin-top: 10px; color: #888;">
        Built with ☁️ Cloudflare Workers | 
        <a href="https://github.com/paulchrisluke/reddit-tracker/blob/main/PRIVACY.md" target="_blank" style="color: inherit;">Privacy Policy</a> | 
        <a href="https://github.com/paulchrisluke/reddit-tracker/discussions" target="_blank" style="color: inherit;">Discussion</a>
      </p>
    </footer>
  </div>

  <script>
    // Update stats on page load
    async function updateStats() {
      try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error('Failed to fetch stats');
        const data = await response.json();
        
        const formatNumber = (num) => {
          if (typeof num === 'number') {
            return num >= 1000 ? (num / 1000).toFixed(1) + 'k' : num.toString();
          }
          return '--';
        };

        const totalUsers = document.getElementById('total-users');
        const topCount = document.getElementById('top-count');
        
        if (totalUsers) totalUsers.textContent = formatNumber(data.total_users);
        if (topCount) topCount.textContent = formatNumber(data.top_count);
        
        // Add animation class to show update
        [totalUsers, topCount].forEach(el => {
          if (el) {
            el.classList.add('updated');
            setTimeout(() => el.classList.remove('updated'), 1000);
          }
        });
      } catch (error) {
        console.error('Error updating stats:', error);
      }
    }
    
    updateStats();

  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html' } });
	},

	// The scheduled handler runs automatically via cron trigger
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
	  if (event.cron === EMBEDDINGS_CRON) {
		ctx.waitUntil(runChunkingPipeline(env, { allowEmbeddings: true }));
		console.log('Cron triggered at ' + event.cron + ': Running embeddings chunking');
		return;
	  }

	  ctx.waitUntil(collectData(env));
	  console.log('Cron triggered at ' + event.cron + ': Starting data collection');
	},
  };

  // Helper function for JSON responses
  function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
	  status,
	  headers: {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'public, max-age=' + CACHE_TTL
	  }
	});
  }

  function renderGamePage(): string {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Is It An Ad? | Reddit Tracker</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Review Reddit posts and label whether they are ads or organic content.">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      background: radial-gradient(circle at top, #202020 0%, #0f0f12 60%, #0a0a0a 100%);
      color: #f2f2f2;
      min-height: 100vh;
      padding: 40px 16px;
    }
    .wrap {
      max-width: 880px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 30px;
    }
    header h1 {
      font-size: 2.4rem;
      letter-spacing: 0.02em;
      margin-bottom: 8px;
    }
    header p {
      color: #b4b4b4;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    }
    .toolbar input {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 10px 12px;
      border-radius: 8px;
      min-width: 180px;
    }
    .btn {
      border: 1px solid rgba(255,255,255,0.25);
      background: rgba(255,255,255,0.08);
      color: #fff;
      padding: 10px 16px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 600;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .btn:hover { transform: translateY(-1px); border-color: rgba(255,140,0,0.7); }
    .btn-primary { background: linear-gradient(135deg, #FF5700, #FF8C00); border: none; }
    .status {
      color: #b4b4b4;
      font-size: 0.9rem;
    }
    .card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 18px;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 14px;
      color: #aaa;
      font-size: 0.9rem;
    }
    .embed {
      width: 100%;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      background: #111;
      min-height: 480px;
    }
    .embed iframe {
      width: 100%;
      height: 520px;
      border: 0;
    }
    .empty {
      color: #888;
      text-align: center;
      padding: 40px 10px;
    }
    .actions {
      display: flex;
      justify-content: center;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      color: #777;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Is It An Ad?</h1>
      <p>Review a post and decide if it feels like an ad. Use skip if it is unclear.</p>
    </header>

    <div class="toolbar">
      <input id="reviewer-id" placeholder="reviewer id" />
      <button class="btn btn-primary" id="load-task">Load Next</button>
      <span class="status" id="status"></span>
    </div>

    <div class="card" id="card">
      <div class="empty">No task loaded yet.</div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" id="label-yes">Yes, it is an ad</button>
      <button class="btn" id="label-no">No, it is organic</button>
      <button class="btn" id="label-skip">Skip (unclear)</button>
    </div>

    <div class="footer">
      Powered by Reddit Tracker · <a href="/" style="color:#FF8C00;">Back to research</a>
    </div>
  </div>

  <script>
    const reviewerInput = document.getElementById('reviewer-id');
    const statusEl = document.getElementById('status');
    const cardEl = document.getElementById('card');
    const loadButton = document.getElementById('load-task');
    const yesButton = document.getElementById('label-yes');
    const noButton = document.getElementById('label-no');
    const skipButton = document.getElementById('label-skip');

    let currentTask = null;
    let currentItem = null;

    function setStatus(message) {
      if (statusEl) statusEl.textContent = message;
    }

    function renderCard(task, item) {
      if (!cardEl) return;
      if (!task) {
        cardEl.innerHTML = '<div class="empty">No pending tasks. Add some via /api/review/enqueue.</div>';
        return;
      }

      const account = task.account_id || 'unknown';
      const reason = task.reason || 'n/a';
      const itemLink = item && item.permalink ? 'https://www.reddit.com' + item.permalink : null;
      const embedUrl = itemLink ? 'https://www.redditmedia.com' + item.permalink + '?ref_source=embed&ref=share&embed=true' : null;

      let html = '';
      html += '<div class="meta">';
      html += '<div>Account: ' + account + '</div>';
      html += '<div>Reason: ' + reason + '</div>';
      html += '</div>';

      if (embedUrl) {
        html += '<div class="embed"><iframe src="' + embedUrl + '" loading="lazy" allow="clipboard-write"></iframe></div>';
      } else {
        html += '<div class="empty">No post attached. Enqueue with a post_id to embed.</div>';
      }

      cardEl.innerHTML = html;
    }

    async function loadNext() {
      setStatus('Loading...');
      const reviewerId = reviewerInput && reviewerInput.value ? reviewerInput.value : 'author';
      if (reviewerInput) localStorage.setItem('reviewerId', reviewerId);
      try {
        const response = await fetch('/api/review/next?reviewer=' + encodeURIComponent(reviewerId) + '&include=item&auto=true');
        const data = await response.json();
        if (!response.ok || data.status === 'empty') {
          currentTask = null;
          currentItem = null;
          renderCard(null, null);
          setStatus('No pending tasks.');
          return;
        }
        currentTask = data.task;
        currentItem = data.item;
        renderCard(data.task, data.item);
        setStatus('Task loaded.');
      } catch (error) {
        setStatus('Failed to load task.');
      }
    }

    async function submitLabel(label) {
      if (!currentTask) {
        setStatus('Load a task first.');
        return;
      }
      const reviewerId = reviewerInput && reviewerInput.value ? reviewerInput.value : 'author';
      setStatus('Submitting...');
      try {
        const response = await fetch('/api/review/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: currentTask.task_id,
            label: label,
            reviewer_id: reviewerId
          })
        });
        const data = await response.json();
        if (!response.ok) {
          setStatus(data.error || 'Submit failed.');
          return;
        }
        setStatus('Submitted.');
        await loadNext();
      } catch (error) {
        setStatus('Submit failed.');
      }
    }

    if (reviewerInput) {
      const saved = localStorage.getItem('reviewerId');
      if (saved) reviewerInput.value = saved;
    }

    if (loadButton) loadButton.addEventListener('click', loadNext);
    if (yesButton) yesButton.addEventListener('click', () => submitLabel('likely_shill'));
    if (noButton) noButton.addEventListener('click', () => submitLabel('likely_organic'));
    if (skipButton) skipButton.addEventListener('click', () => submitLabel('unclear'));

    loadNext();
  </script>
</body>
</html>
`;
  }

  // Run the incremental chunking pipeline
  async function runChunkingPipeline(env: Env, options: { allowEmbeddings?: boolean } = {}) {
	if (!env.DB) {
		console.log('Skipping chunking: DB not configured');
		return;
	}
	
	console.log('Starting Chunking Pipeline...');
	try {
		const allowEmbeddings = options.allowEmbeddings === true;
		const db = new D1ChunkingDatabase(env.DB, allowEmbeddings ? env.VECTORIZE : undefined);
		
		// Configure embedding provider - Prefer Cloudflare AI
		const embeddingProvider = createEmbeddingProvider({
			provider: allowEmbeddings ? (env.AI ? 'cloudflare' : (env.OPENAI_API_KEY ? 'openai' : 'stub')) : 'stub',
			aiBinding: env.AI,
			openaiApiKey: env.OPENAI_API_KEY
		});
		
		const config = allowEmbeddings
			? DEFAULT_CHUNK_CONFIG
			: { ...DEFAULT_CHUNK_CONFIG, maxEmbeddingsPerRun: 0, skipChunkLookups: true };
		const pipeline = new ChunkingPipeline(db, embeddingProvider, config);
		const result = await pipeline.run();
		
		console.log('Chunking Pipeline Complete:', result);
		return result;
	} catch (error) {
		console.error('Chunking Pipeline Failed:', error);
		throw error;
	}
  }

  // Main data collection function
  async function collectData(env: Env): Promise<{ posts_fetched: number; users_updated: number; top_list_count: number; date: string; comment_users?: number; comments_fetched?: number; comments_processed?: number; chunking_result?: any }> {
	const today = new Date().toISOString().split('T')[0];

	console.log('Starting data collection for ' + today);

	try {
	  // Fetch from Reddit
	  const posts = await fetchPostsFromReddit();

	  if (posts.length === 0) {
		console.log('No posts fetched');
		return { posts_fetched: 0, users_updated: 0, top_list_count: 0, date: today };
	  }

	  // Process posts and update user stats
	  const processedCount = await processPosts(posts, today, env);

	  // Update top 1000 lists
	  const topCount = await updateTopList(env, today);

	  // Seed comments for top users to enrich behavioral signals
	  const commentResult = await collectCommentsForTopUsers(env, today);

	  // Track collection count for today
	  const collectionsToday = parseInt(await env.REDDIT_CONFIG.get('collections_' + today) || '0');
	  await env.REDDIT_CONFIG.put('collections_' + today, String(collectionsToday + 1), {
		expirationTtl: 2 * 86400
	  });
	  await env.REDDIT_CONFIG.put('last_' + today, new Date().toISOString(), {
		expirationTtl: 2 * 86400
	  });

	  console.log('Collection #' + (collectionsToday + 1) + ' completed. Processed ' + processedCount + ' posts.');
	  
	  // Run chunking pipeline immediately after collection if DB is present
	  let chunkingResult;
	  if (env.DB) {
		chunkingResult = await runChunkingPipeline(env);
	  }

	  return {
		posts_fetched: posts.length,
		users_updated: processedCount,
		top_list_count: topCount,
		date: today,
		comment_users: commentResult.users_processed,
		comments_fetched: commentResult.comments_fetched,
		comments_processed: commentResult.comments_processed,
		chunking_result: chunkingResult
	  };

	} catch (error) {
	  console.error('Error in collection:', error);
	  await env.REDDIT_CONFIG.put('error_' + today, error instanceof Error ? error.message : String(error), {
		expirationTtl: 86400
	  });
	  throw error;
	}
  }

  // Fetch posts from Reddit API
  async function fetchPostsFromReddit(): Promise<any[]> {
	const endpoints = [
	  '/r/all/hot.json?limit=50',
	  '/r/all/new.json?limit=50',
	  '/r/all/rising.json?limit=50'
	];

	const allPosts: any[] = [];
	const seenIds = new Set<string>();

	for (const endpoint of endpoints) {
	  try {
		const response = await fetch('https://old.reddit.com' + endpoint, {
		  headers: { 
			'User-Agent': USER_AGENT,
			'Accept': 'application/json',
			'Accept-Language': 'en-US,en;q=0.9',
			'Cache-Control': 'no-cache',
			'Pragma': 'no-cache'
		  }
		});

		if (!response.ok) {
		  console.error('Failed to fetch ' + endpoint + ': ' + response.status);
		  continue;
		}

		const data: any = await response.json();
		const posts = data.data?.children || [];

		// Filter posts from last 24 hours and deduplicate
		const now = Math.floor(Date.now() / 1000);
		for (const post of posts) {
		  const postData = post.data;
		  const postId = postData.id;
		  const created = postData.created_utc;

		  if (!postId || seenIds.has(postId)) continue;
		  if (now - created > 86400) continue; // Older than 24 hours

		  seenIds.add(postId);
		  allPosts.push(postData);
		}

	  } catch (error) {
		console.error('Error fetching from ' + endpoint + ':', error);
	  }
	}

	// Limit to prevent hitting rate limits
	return allPosts.slice(0, MAX_POSTS_PER_DAY);
  }

  async function fetchUserListing(username: string, listing: 'submitted' | 'comments', limit: number, maxPages: number): Promise<any[]> {
	const items: any[] = [];
	const seenIds = new Set<string>();
	let after: string | null = null;
	let pages = 0;
	const pageSize = Math.min(100, Math.max(1, limit));

	while (items.length < limit && pages < maxPages) {
	  const query = new URLSearchParams({ limit: String(pageSize) });
	  if (after) query.set('after', after);
	  const url = `https://old.reddit.com/user/${encodeURIComponent(username)}/${listing}.json?${query.toString()}`;

	  try {
		const response = await fetch(url, {
		  headers: { 
			'User-Agent': USER_AGENT,
			'Accept': 'application/json',
			'Accept-Language': 'en-US,en;q=0.9',
			'Cache-Control': 'no-cache',
			'Pragma': 'no-cache'
		  }
		});

		if (!response.ok) {
		  console.error('Failed to fetch user listing:', username, listing, response.status);
		  break;
		}

		const data: any = await response.json();
		const posts = data.data?.children || [];

		for (const post of posts) {
		  const postData = post.data;
		  const postId = postData?.id;
		  if (!postId || seenIds.has(postId)) continue;
		  seenIds.add(postId);
		  items.push(postData);
		  if (items.length >= limit) break;
		}

		after = data.data?.after || null;
		if (!after) break;
		pages += 1;
	  } catch (error) {
		console.error('Error fetching user listing:', username, listing, error);
		break;
	  }
	}

	return items.slice(0, limit);
  }

  async function fetchUserAbout(username: string): Promise<any | null> {
	try {
	  const response = await fetch(`https://old.reddit.com/user/${encodeURIComponent(username)}/about.json`, {
		headers: { 
		  'User-Agent': USER_AGENT,
		  'Accept': 'application/json',
		  'Accept-Language': 'en-US,en;q=0.9',
		  'Cache-Control': 'no-cache',
		  'Pragma': 'no-cache'
		}
	  });

	  if (!response.ok) {
		console.error('Failed to fetch user about:', username, response.status);
		return null;
	  }

	  const data: any = await response.json();
	  return data?.data || null;
	} catch (error) {
	  console.error('Error fetching user about:', username, error);
	  return null;
	}
  }

  async function collectCommentsForTopUsers(env: Env, date: string): Promise<CommentCollectionResult> {
	let topListRaw = await env.REDDIT_TOP_LISTS.get('latest');
	if (!topListRaw) {
	  return { users_processed: 0, comments_fetched: 0, comments_processed: 0 };
	}

	const topList = JSON.parse(topListRaw) as TopUser[];
	if (!Array.isArray(topList) || topList.length === 0) {
	  return { users_processed: 0, comments_fetched: 0, comments_processed: 0 };
	}

	const cursorRaw = await env.REDDIT_CONFIG.get('comment_seed_cursor');
	let cursor = cursorRaw ? parseInt(cursorRaw, 10) : 0;
	if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
	if (cursor >= topList.length) cursor = 0;

	let batch = topList.slice(cursor, cursor + COMMENT_SEED_BATCH);
	if (batch.length === 0) {
	  cursor = 0;
	  batch = topList.slice(0, COMMENT_SEED_BATCH);
	}

	let commentsFetched = 0;
	let commentsProcessed = 0;
	const now = Math.floor(Date.now() / 1000);

	for (const user of batch) {
	  const username = user.username;
	  if (!username) continue;
	  const comments = await fetchUserListing(username, 'comments', COMMENT_SEED_LIMIT, COMMENT_SEED_PAGES);
	  commentsFetched += comments.length;
	  commentsProcessed += await processItems(comments, date, env, 'comment');

	  const about = await fetchUserAbout(username);
	  const profile = normalizeUserProfile(about);
	  if (profile) {
		await upsertUserProfile(env, username, profile, date);
		await insertProfileSnapshot(env, username, profile, now);
	  }
	}

	const nextCursor = (cursor + COMMENT_SEED_BATCH) % topList.length;
	await env.REDDIT_CONFIG.put('comment_seed_cursor', String(nextCursor), { expirationTtl: 7 * 86400 });

	return { users_processed: batch.length, comments_fetched: commentsFetched, comments_processed: commentsProcessed };
  }

  function normalizeUserProfile(about: any): UserProfile | null {
	if (!about || typeof about !== 'object') return null;
	return {
	  created_utc: Number.isFinite(about.created_utc) ? about.created_utc : undefined,
	  link_karma: Number.isFinite(about.link_karma) ? about.link_karma : undefined,
	  comment_karma: Number.isFinite(about.comment_karma) ? about.comment_karma : undefined,
	  is_mod: typeof about.is_mod === 'boolean' ? about.is_mod : undefined,
	  is_gold: typeof about.is_gold === 'boolean' ? about.is_gold : undefined,
	  has_verified_email: typeof about.has_verified_email === 'boolean' ? about.has_verified_email : undefined
	};
  }

  async function upsertUserProfile(env: Env, username: string, profile: UserProfile | null, date: string): Promise<void> {
	if (!profile) return;
	const userKey = `user_${username.toLowerCase()}`;
	const existingData = await env.REDDIT_USERS.get(userKey);
	let userData: UserData;

	if (existingData) {
	  userData = JSON.parse(existingData);
	} else {
	  userData = {
		username,
		post_count: 0,
		comment_count: 0,
		comment_score: 0,
		total_karma: 0,
		first_seen: date,
		last_updated: Date.now(),
		daily_posts: {},
		daily_comments: {},
		subreddits: {},
		comment_subreddits: {},
		domains: {},
		hourly_posts: {},
		hourly_comments: {},
		post_types: {},
		urls: {}
	  };
	}

	userData.profile = profile;
	userData.last_updated = Date.now();
	if (!userData.first_seen) {
	  userData.first_seen = date;
	}

	await env.REDDIT_USERS.put(userKey, JSON.stringify(userData));
  }

  function boolToInt(value: boolean | undefined): number | null {
	if (typeof value !== 'boolean') return null;
	return value ? 1 : 0;
  }

  async function insertProfileSnapshot(env: Env, username: string, profile: UserProfile | null, snapshotTs: number): Promise<void> {
	if (!env.DB || !profile) return;
	const accountId = username.toLowerCase();
	await env.DB.prepare(`
	  INSERT INTO account_profile_snapshots (
		account_id, snapshot_ts, created_utc, link_karma, comment_karma, is_mod, is_gold, has_verified_email
	  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
	  accountId,
	  snapshotTs,
	  profile.created_utc ?? null,
	  profile.link_karma ?? null,
	  profile.comment_karma ?? null,
	  boolToInt(profile.is_mod),
	  boolToInt(profile.is_gold),
	  boolToInt(profile.has_verified_email)
	).run();
  }

  function formatUtcDate(createdUtc: number | undefined): string | null {
	if (!createdUtc || !Number.isFinite(createdUtc)) return null;
	try {
	  return new Date(createdUtc * 1000).toISOString().split('T')[0];
	} catch {
	  return null;
	}
  }

  function getPostHourKey(createdUtc: number | undefined): string | null {
	if (!createdUtc || !Number.isFinite(createdUtc)) return null;
	try {
	  const hour = new Date(createdUtc * 1000).getUTCHours();
	  return String(hour);
	} catch {
	  return null;
	}
  }

  function getPostTypes(post: any): string[] {
	const types: string[] = [];
	const postHint = post?.post_hint || '';
	const domain = post?.domain || '';
	const isSelf = Boolean(post?.is_self) || postHint === 'self';
	const isGallery = Boolean(post?.is_gallery);
	const isVideo = Boolean(post?.is_video) || Boolean(post?.media?.reddit_video);
	const isImage = postHint === 'image' || domain === 'i.redd.it';
	const isCrosspost = Boolean(post?.crosspost_parent) || Array.isArray(post?.crosspost_parent_list);

	if (isSelf) types.push('self');
	if (isGallery) types.push('gallery');
	if (isVideo) types.push('video');
	if (isImage) types.push('image');
	if (!isSelf && !isGallery && !isVideo && !isImage) types.push('link');
	if (isCrosspost) types.push('crosspost');

	return types;
  }

  function shouldTrackUrl(domain: string | undefined): boolean {
	if (!domain) return false;
	const normalized = domain.toLowerCase();
	if (normalized.startsWith('self.')) return false;
	if (normalized.endsWith('reddit.com') || normalized.endsWith('redd.it')) return false;
	return true;
  }

  function normalizeUrl(rawUrl: string | undefined): string | null {
	if (!rawUrl) return null;
	try {
	  const url = new URL(rawUrl);
	  const removeParams = new Set(['fbclid', 'gclid', 'igshid', 'ref', 'ref_src']);
	  for (const key of Array.from(url.searchParams.keys())) {
		if (key.startsWith('utm_') || removeParams.has(key)) {
		  url.searchParams.delete(key);
		}
	  }

	  url.hash = '';
	  const host = url.hostname.toLowerCase();
	  url.hostname = host.startsWith('www.') ? host.slice(4) : host;
	  const normalized = url.toString();
	  if (normalized.length > 1 && normalized.endsWith('/')) {
		return normalized.slice(0, -1);
	  }
	  return normalized;
	} catch {
	  return null;
	}
  }

  type CollectedItemType = 'post' | 'comment';

  async function processItems(items: any[], date: string, env: Env, itemType: CollectedItemType): Promise<number> {
	if (items.length === 0) return 0;

	const itemKeys = items.map((item) => {
	  const itemDate = formatUtcDate(item.created_utc) || date;
	  const itemId = item.name || item.id;
	  return `${itemType}_${itemDate}_${itemId}`;
	});
	const userKeys = items.map((item) => `user_${String(item.author || 'unknown').toLowerCase()}`);

	const existingItems = new Map<string, string | null>();
	const existingUsers = new Map<string, string | null>();

	for (let i = 0; i < items.length; i += 20) {
	  const batchItems = itemKeys.slice(i, i + 20);
	  const batchUsers = userKeys.slice(i, i + 20);

	  const [itemResults, userResults] = await Promise.all([
		Promise.all(batchItems.map((k) => env.REDDIT_POSTS.get(k))),
		Promise.all(batchUsers.map((k) => env.REDDIT_USERS.get(k)))
	  ]);

	  batchItems.forEach((k, idx) => existingItems.set(k, itemResults[idx]));
	  batchUsers.forEach((k, idx) => existingUsers.set(k, userResults[idx]));
	}

	const userUpdates = new Map<string, string>();
	const urlRows: Array<{
	  account_id: string;
	  post_id: string;
	  url: string;
	  domain: string | null;
	  created_utc: number | null;
	  ingested_at: number;
	}> = [];
	const itemMarkers: [string, string][] = [];
	let count = 0;
	const ingestedAt = Math.floor(Date.now() / 1000);

	for (const item of items) {
	  const author = item.author;
	  if (!author || author === '[deleted]' || author === '[removed]' || author === 'AutoModerator') continue;

	  const itemDate = formatUtcDate(item.created_utc) || date;
	  const itemId = item.name || item.id;
	  const itemKey = `${itemType}_${itemDate}_${itemId}`;
	  if (existingItems.get(itemKey)) continue;

	  const userKey = `user_${author.toLowerCase()}`;
	  let userData: UserData;

	  const existingData = userUpdates.get(userKey) || existingUsers.get(userKey);

	  if (existingData) {
		userData = JSON.parse(existingData);
	  } else {
		userData = {
		  username: author,
		  post_count: 0,
		  comment_count: 0,
		  comment_score: 0,
		  total_karma: 0,
		  first_seen: itemDate,
		  last_updated: Date.now(),
		  daily_posts: {},
		  daily_comments: {},
		  subreddits: {},
		  comment_subreddits: {},
		  domains: {},
		  hourly_posts: {},
		  hourly_comments: {},
		  post_types: {},
		  urls: {}
		};
	  }

	  if (!Number.isFinite(userData.post_count)) userData.post_count = 0;
	  if (!Number.isFinite(userData.comment_count)) userData.comment_count = 0;
	  if (!Number.isFinite(userData.comment_score)) userData.comment_score = 0;
	  if (!Number.isFinite(userData.total_karma)) userData.total_karma = 0;

	  userData.last_updated = Date.now();
	  if (!userData.first_seen || userData.first_seen > itemDate) {
		userData.first_seen = itemDate;
	  }

	  if (itemType === 'post') {
		userData.post_count += 1;
		userData.total_karma += item.score || 0;
		if (!userData.daily_posts) userData.daily_posts = {};
		userData.daily_posts[itemDate] = (userData.daily_posts[itemDate] || 0) + 1;

		if (!userData.subreddits) userData.subreddits = {};
		if (!userData.domains) userData.domains = {};
		if (!userData.hourly_posts) userData.hourly_posts = {};
		if (!userData.post_types) userData.post_types = {};
		if (!userData.urls) userData.urls = {};

		const sub = item.subreddit;
		const domain = item.domain;
		const postHour = getPostHourKey(item.created_utc);
		const postTypes = getPostTypes(item);

		if (sub) userData.subreddits[sub] = (userData.subreddits[sub] || 0) + 1;
		if (domain) userData.domains[domain] = (userData.domains[domain] || 0) + 1;
		if (postHour) userData.hourly_posts[postHour] = (userData.hourly_posts[postHour] || 0) + 1;
		for (const postType of postTypes) {
		  userData.post_types[postType] = (userData.post_types[postType] || 0) + 1;
		}

		if (shouldTrackUrl(domain)) {
		  const normalized = normalizeUrl(item.url);
		  if (normalized) {
			const urlCount = userData.urls[normalized];
			const urlTotal = Object.keys(userData.urls).length;
			if (urlCount !== undefined || urlTotal < MAX_URLS_PER_USER) {
			  userData.urls[normalized] = (urlCount || 0) + 1;
			  if (env.DB) {
				urlRows.push({
				  account_id: author.toLowerCase(),
				  post_id: itemId,
				  url: normalized,
				  domain: domain || null,
				  created_utc: Number.isFinite(item.created_utc) ? item.created_utc : null,
				  ingested_at: ingestedAt
				});
			  }
			}
		  }
		}
	  } else {
		userData.comment_count += 1;
		userData.comment_score = (userData.comment_score || 0) + (item.score || 0);
		if (!userData.daily_comments) userData.daily_comments = {};
		userData.daily_comments[itemDate] = (userData.daily_comments[itemDate] || 0) + 1;

		if (!userData.comment_subreddits) userData.comment_subreddits = {};
		if (!userData.hourly_comments) userData.hourly_comments = {};

		const sub = item.subreddit;
		const commentHour = getPostHourKey(item.created_utc);
		if (sub) userData.comment_subreddits[sub] = (userData.comment_subreddits[sub] || 0) + 1;
		if (commentHour) userData.hourly_comments[commentHour] = (userData.hourly_comments[commentHour] || 0) + 1;
	  }

	  userUpdates.set(userKey, JSON.stringify(userData));
	  itemMarkers.push([itemKey, '1']);
	  count++;
	}

	const updates = Array.from(userUpdates.entries());
	for (let i = 0; i < updates.length; i += 20) {
	  await Promise.all(updates.slice(i, i + 20).map(([k, v]) => env.REDDIT_USERS.put(k, v)));
	}

	for (let i = 0; i < itemMarkers.length; i += 20) {
	  await Promise.all(itemMarkers.slice(i, i + 20).map(([k, v]) => env.REDDIT_POSTS.put(k, v)));
	}

	if (env.DB) {
	  try {
		const d1Db = new D1ChunkingDatabase(env.DB);
		const rawItems: RawItem[] = [];

		for (const item of items) {
		  const author = item.author;
		  if (!author || author === '[deleted]' || author === '[removed]' || author === 'AutoModerator') continue;

		  if (itemType === 'post') {
			rawItems.push({
			  id: item.name || `t3_${item.id}`,
			  item_type: 'post',
			  account_id: author.toLowerCase(),
			  thread_id: item.name || `t3_${item.id}`,
			  parent_id: null,
			  subreddit: item.subreddit,
			  created_utc: item.created_utc,
			  title: item.title,
			  body: item.selftext || '',
			  score: item.score,
			  permalink: item.permalink,
			  ingested_at: ingestedAt,
			  raw_json: JSON.stringify(item)
			});
		  } else {
			rawItems.push({
			  id: item.name || `t1_${item.id}`,
			  item_type: 'comment',
			  account_id: author.toLowerCase(),
			  thread_id: item.link_id || item.name || `t3_${item.id}`,
			  parent_id: item.parent_id || null,
			  subreddit: item.subreddit,
			  created_utc: item.created_utc,
			  title: null,
			  body: item.body || '',
			  score: item.score,
			  permalink: item.permalink,
			  ingested_at: ingestedAt,
			  raw_json: JSON.stringify(item)
			});
		  }
		}

		const BATCH_SIZE = 50;
		for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
		  await d1Db.insertItems(rawItems.slice(i, i + BATCH_SIZE));
		}
		console.log(`📥 Stored ${rawItems.length} items in D1 for chunking`);

		if (urlRows.length > 0) {
		  const urlStmt = env.DB.prepare(`
			INSERT OR IGNORE INTO account_urls (account_id, post_id, url, domain, created_utc, ingested_at)
			VALUES (?, ?, ?, ?, ?, ?)
		  `);
		  const urlBatch = urlRows.map((row) => urlStmt.bind(
			row.account_id,
			row.post_id,
			row.url,
			row.domain,
			row.created_utc,
			row.ingested_at
		  ));
		  await env.DB.batch(urlBatch);
		  console.log(`🔗 Stored ${urlRows.length} account URLs`);
		}
	  } catch (d1Error) {
		console.error('Error storing items in D1:', d1Error);
	  }
	}

	return count;
  }

  // Process posts and update user statistics
  async function processPosts(posts: any[], date: string, env: Env): Promise<number> {
	return processItems(posts, date, env, 'post');
  }

  // Update top 1000 list
  async function updateTopList(env: Env, date: string): Promise<number> {
	try {
	  if (env.DB) {
		const cutoff = Math.floor(Date.now() / 1000) - KV_TTL;
		const rows = await env.DB.prepare(`
		  WITH user_counts AS (
			SELECT account_id, subreddit, COUNT(*) AS cnt
			FROM items
			WHERE item_type = 'post'
			  AND created_utc >= ?
			GROUP BY account_id, subreddit
		  ),
		  ranked AS (
			SELECT account_id, subreddit, cnt,
				   ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY cnt DESC) AS rn
			FROM user_counts
		  ),
		  top_sub AS (
			SELECT account_id, subreddit AS top_subreddit
			FROM ranked
			WHERE rn = 1
		  ),
		  summary AS (
			SELECT account_id,
				   COUNT(*) AS post_count,
				   MIN(created_utc) AS first_seen,
				   MAX(created_utc) AS last_seen,
				   SUM(score) AS total_score
			FROM items
			WHERE item_type = 'post'
			  AND created_utc >= ?
			GROUP BY account_id
		  )
		  SELECT summary.*, top_sub.top_subreddit
		  FROM summary
		  LEFT JOIN top_sub ON top_sub.account_id = summary.account_id
		  ORDER BY post_count DESC
		  LIMIT 1000
		`).bind(cutoff, cutoff).all();

		const results = (rows.results || []) as Array<Record<string, any>>;
		if (results.length > 0) {
		  const top1000: TopUser[] = results.map((row, index) => {
			const postCount = coerceNumber(row.post_count) ?? 0;
			const firstSeenUtc = coerceNumber(row.first_seen);
			const lastSeenUtc = coerceNumber(row.last_seen);
			const daysActive = (firstSeenUtc !== null && lastSeenUtc !== null && lastSeenUtc >= firstSeenUtc)
			  ? Math.ceil((lastSeenUtc - firstSeenUtc) / 86400) + 1
			  : 1;
			const dailyAverage = daysActive > 0 ? postCount / daysActive : postCount;

			return {
			  rank: index + 1,
			  username: String(row.account_id),
			  post_count: postCount,
			  total_karma: coerceNumber(row.total_score) ?? 0,
			  first_seen: formatUtcDate(firstSeenUtc || undefined) || date,
			  daily_average: dailyAverage,
			  top_subreddit: row.top_subreddit ? String(row.top_subreddit) : 'N/A'
			};
		  });

		  await env.REDDIT_TOP_LISTS.put(`top_${date}`, JSON.stringify(top1000), {
			expirationTtl: KV_TTL
		  });

		  await env.REDDIT_TOP_LISTS.put('latest', JSON.stringify(top1000), {
			expirationTtl: 86400
		  });

		  console.log(`📊 Updated top list with ${top1000.length} users (D1)`);
		  return top1000.length;
		}
	  }

	  // Get all users
	  const users: UserData[] = [];
	  let cursor: string | undefined;

	  do {
		const list: any = await env.REDDIT_USERS.list({ cursor });
		cursor = list.cursor;

		const keys = list.keys.filter((key: any) => key.name.startsWith('user_'));
		
		// Batch get in chunks of 50
		for (let i = 0; i < keys.length; i += 50) {
		  const batch = keys.slice(i, i + 50);
		  const userDataResults = await Promise.all(batch.map((key: any) => env.REDDIT_USERS.get(key.name)));
		  
		  for (const userData of userDataResults) {
			if (userData) {
			  const user = JSON.parse(userData) as UserData;
			  if (user.post_count > 0) {
				users.push(user);
			  }
			}
		  }
		}
	  } while (cursor);

	  // Sort by post count and take top 1000
	  users.sort((a, b) => b.post_count - a.post_count);
	  const top1000: TopUser[] = users.slice(0, 1000).map((user, index) => {
		// Calculate top subreddit
		let topSub = 'N/A';
		if (user.subreddits) {
			const sortedSubs = Object.entries(user.subreddits).sort(([,a], [,b]) => b - a);
			if (sortedSubs.length > 0) topSub = sortedSubs[0][0];
		}

		return {
			rank: index + 1,
			username: user.username,
			post_count: user.post_count,
			total_karma: user.total_karma || 0,
			first_seen: user.first_seen || date,
			daily_average: calculateDailyAverage(user),
			top_subreddit: topSub
		};
	  });

	  // Store top list
	  await env.REDDIT_TOP_LISTS.put(`top_${date}`, JSON.stringify(top1000), {
		expirationTtl: KV_TTL
	  });

	  // Update latest
	  await env.REDDIT_TOP_LISTS.put('latest', JSON.stringify(top1000), {
		expirationTtl: 86400
	  });

	  console.log(`📊 Updated top list with ${top1000.length} users`);
	  return top1000.length;

	} catch (error) {
	  console.error('Error updating top list:', error);
	  return 0;
	}
  }

  // Calculate daily average posts
  function calculateDailyAverage(user: UserData): number {
	if (!user.first_seen) return 0;

	try {
	  const firstDate = new Date(user.first_seen);
	  const today = new Date();
	  const daysActive = Math.ceil((today.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

	  return daysActive > 0 ? user.post_count / daysActive : 0;
	} catch {
	  return 0;
	}
  }

  type IncludeFlags = {
	includeSignals: boolean;
	includeBreakdown: boolean;
	includeSubreddits: boolean;
	includeDomains: boolean;
	includeHourly: boolean;
	includePostTypes: boolean;
	includeUrls: boolean;
	includeComments: boolean;
	includeProfile: boolean;
	includeProfileSnapshots: boolean;
	includeUrlReuse: boolean;
	includeItem: boolean;
  };

  function parseIncludeFlags(includeParam: string | null): IncludeFlags {
	const include = new Set((includeParam || '').split(',').map((value) => value.trim()).filter(Boolean));
	const includeSignals = include.has('signals') || include.has('all');
	const includeBreakdown = include.has('breakdown') || includeSignals;
	const includeSubreddits = include.has('subreddits') || includeBreakdown;
	const includeDomains = include.has('domains') || includeBreakdown;
	const includeHourly = include.has('hourly') || includeBreakdown;
	const includePostTypes = include.has('post_types') || includeBreakdown;
	const includeUrls = include.has('urls') || includeBreakdown;
	const includeComments = include.has('comments') || includeBreakdown;
	const includeProfile = include.has('profile') || include.has('all');
	const includeProfileSnapshots = include.has('profile_snapshots') || include.has('all');
	const includeUrlReuse = include.has('url_reuse') || include.has('all');
	const includeItem = include.has('item') || include.has('all');

	return {
	  includeSignals,
	  includeBreakdown,
	  includeSubreddits,
	  includeDomains,
	  includeHourly,
	  includePostTypes,
	  includeUrls,
	  includeComments,
	  includeProfile,
	  includeProfileSnapshots,
	  includeUrlReuse,
	  includeItem
	};
  }

  function buildUserResponse(user: UserData, flags: IncludeFlags): UserResponse {
	const response: UserResponse = {
	  username: user.username,
	  post_count: user.post_count,
	  comment_count: user.comment_count || 0,
	  total_karma: user.total_karma || 0,
	  first_seen: user.first_seen,
	  last_updated: new Date(user.last_updated || Date.now()).toISOString(),
	  daily_average: calculateDailyAverage(user),
	  recent_activity: user.daily_posts || {}
	};

	if (flags.includeSubreddits) {
	  response.subreddits = user.subreddits || {};
	}

	if (flags.includeDomains) {
	  response.domains = user.domains || {};
	}

	if (flags.includeHourly) {
	  response.hourly_posts = user.hourly_posts || {};
	}

	if (flags.includePostTypes) {
	  response.post_types = user.post_types || {};
	}

	if (flags.includeUrls) {
	  response.urls = user.urls || {};
	}

	if (flags.includeComments) {
	  response.comment_score = user.comment_score || 0;
	  response.recent_comments = user.daily_comments || {};
	  response.comment_subreddits = user.comment_subreddits || {};
	  response.hourly_comments = user.hourly_comments || {};
	}

	if (flags.includeProfile) {
	  response.profile = user.profile;
	}

	return response;
  }

  function coerceNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
	  const parsed = Number(value);
	  return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
  }

  async function fetchProfileSnapshotStats(env: Env, accountId: string): Promise<ProfileSnapshotStats | undefined> {
	if (!env.DB) return undefined;

	const summary = await env.DB.prepare(`
	  SELECT COUNT(*) AS count,
			 MIN(snapshot_ts) AS first_ts,
			 MAX(snapshot_ts) AS last_ts
	  FROM account_profile_snapshots
	  WHERE account_id = ?
	`).bind(accountId).first() as Record<string, any> | null;

	const count = coerceNumber(summary?.count) ?? 0;
	const firstTs = coerceNumber(summary?.first_ts);
	const lastTs = coerceNumber(summary?.last_ts);

	if (count === 0) {
	  return {
		count: 0,
		first_ts: null,
		last_ts: null,
		delta_link_karma: null,
		delta_comment_karma: null
	  };
	}

	const firstRow = await env.DB.prepare(`
	  SELECT link_karma, comment_karma
	  FROM account_profile_snapshots
	  WHERE account_id = ?
	  ORDER BY snapshot_ts ASC
	  LIMIT 1
	`).bind(accountId).first() as Record<string, any> | null;

	const lastRow = await env.DB.prepare(`
	  SELECT link_karma, comment_karma
	  FROM account_profile_snapshots
	  WHERE account_id = ?
	  ORDER BY snapshot_ts DESC
	  LIMIT 1
	`).bind(accountId).first() as Record<string, any> | null;

	const firstLink = coerceNumber(firstRow?.link_karma);
	const lastLink = coerceNumber(lastRow?.link_karma);
	const firstComment = coerceNumber(firstRow?.comment_karma);
	const lastComment = coerceNumber(lastRow?.comment_karma);

	const deltaLink = (firstLink !== null && lastLink !== null) ? lastLink - firstLink : null;
	const deltaComment = (firstComment !== null && lastComment !== null) ? lastComment - firstComment : null;

	return {
	  count,
	  first_ts: firstTs,
	  last_ts: lastTs,
	  delta_link_karma: deltaLink,
	  delta_comment_karma: deltaComment
	};
  }

  async function fetchUrlReuseStats(env: Env, accountId: string): Promise<UrlReuseStats | undefined> {
	if (!env.DB) return undefined;

	const distinctRow = await env.DB.prepare(`
	  SELECT COUNT(DISTINCT url) AS distinct_urls
	  FROM account_urls
	  WHERE account_id = ?
	`).bind(accountId).first() as Record<string, any> | null;

	const distinct = coerceNumber(distinctRow?.distinct_urls) ?? 0;

	const sharedRow = await env.DB.prepare(`
	  SELECT COUNT(*) AS shared_urls FROM (
		SELECT url
		FROM account_urls
		WHERE url IN (SELECT url FROM account_urls WHERE account_id = ?)
		GROUP BY url
		HAVING COUNT(DISTINCT account_id) > 1
	  ) t
	`).bind(accountId).first() as Record<string, any> | null;

	const shared = coerceNumber(sharedRow?.shared_urls) ?? 0;

	return {
	  distinct_urls: distinct,
	  shared_urls: shared,
	  shared_url_ratio: distinct > 0 ? shared / distinct : 0
	};
  }

  async function getUserData(env: Env, username: string): Promise<UserData | null> {
	const userKey = `user_${username.toLowerCase()}`;
	const userData = await env.REDDIT_USERS.get(userKey);
	if (!userData) return null;
	return JSON.parse(userData) as UserData;
  }

  async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
	  .map((byte) => byte.toString(16).padStart(2, '0'))
	  .join('');
  }

  // Cleanup old data
  async function cleanupOldData(env: Env): Promise<void> {
	try {
	  // Delete post markers older than 7 days
	  const cutoffDate = new Date();
	  cutoffDate.setDate(cutoffDate.getDate() - 7);
	  const cutoffStr = cutoffDate.toISOString().split('T')[0];

	  let cursor: string | undefined;
	  const keysToDelete: string[] = [];

	  do {
	  const list: any = await env.REDDIT_POSTS.list({ cursor });
		cursor = list.cursor;

		for (const key of list.keys) {
		  const parts = key.name.split('_');
		  if (parts.length >= 2 && (parts[0] === 'post' || parts[0] === 'comment')) {
			const postDate = parts[1];
			if (postDate < cutoffStr) {
			  keysToDelete.push(key.name);
			}
		  }
		}
	  } while (cursor);

	  // Delete in batches of 20 to avoid concurrency limits
	  for (let i = 0; i < keysToDelete.length; i += 20) {
		const batch = keysToDelete.slice(i, i + 20);
		await Promise.all(batch.map(key => env.REDDIT_POSTS.delete(key)));
	  }

	  console.log(`🧹 Cleaned up ${keysToDelete.length} old post markers`);

	} catch (error) {
	  console.error('Error in cleanup:', error);
	}
  }

  // API handlers
  async function handleTopPosters(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);
	const offset = parseInt(url.searchParams.get('offset') || '0');

	// Try cache first
	const cacheKey = `cache_${date}_${limit}_${offset}`;
	const cached = await env.REDDIT_TOP_LISTS.get(cacheKey);

	if (cached) {
	  return jsonResponse(JSON.parse(cached));
	}

	// Get data
	const dataKey = `top_${date}`;
	let data = await env.REDDIT_TOP_LISTS.get(dataKey);

	if (!data) {
	  data = await env.REDDIT_TOP_LISTS.get('latest');
	  if (!data) {
		return jsonResponse({ error: 'No data available', users: [] }, 404);
	  }
	}

	const topList: TopUser[] = JSON.parse(data);
	const paginated = topList.slice(offset, offset + limit);

	const response: TopPostersResponse = {
	  date,
	  total: topList.length,
	  limit,
	  offset,
	  has_more: (offset + limit) < topList.length,
	  users: paginated
	};

	// Cache response
	await env.REDDIT_TOP_LISTS.put(cacheKey, JSON.stringify(response), {
	  expirationTtl: CACHE_TTL
	});

	return jsonResponse(response);
  }

  async function handleUserSearch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const username = url.searchParams.get('username');

	if (!username) {
	  return jsonResponse({ error: 'Username required' }, 400);
	}

	const userData = await getUserData(env, username);

	if (!userData) {
	  return jsonResponse({ error: 'User not found' }, 404);
	}

	const flags = parseIncludeFlags(url.searchParams.get('include'));
	const response = buildUserResponse(userData, flags);
	const accountId = username.toLowerCase();

	if (flags.includeProfileSnapshots) {
	  response.profile_snapshots = await fetchProfileSnapshotStats(env, accountId);
	}

	if (flags.includeUrlReuse) {
	  response.url_reuse = await fetchUrlReuseStats(env, accountId);
	}

	return jsonResponse(response);
  }

  async function handleCollectUser(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const username = url.searchParams.get('username');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), MAX_USER_ITEMS);
	const pages = Math.min(parseInt(url.searchParams.get('pages') || '1'), MAX_USER_PAGES);
	const includeProfile = url.searchParams.get('profile') !== 'false';
	const includeComments = url.searchParams.get('comments') !== 'false';

	if (!username) {
	  return jsonResponse({ error: 'Username required' }, 400);
	}

	const today = new Date().toISOString().split('T')[0];

	const submissions = await fetchUserListing(username, 'submitted', limit, pages);
	const processedPosts = await processItems(submissions, today, env, 'post');

	let comments: any[] = [];
	let processedComments = 0;
	if (includeComments) {
	  comments = await fetchUserListing(username, 'comments', limit, pages);
	  processedComments = await processItems(comments, today, env, 'comment');
	}

	let profileUpdated = false;
	if (includeProfile) {
	  const about = await fetchUserAbout(username);
	  const profile = normalizeUserProfile(about);
	  if (profile) {
		await upsertUserProfile(env, username, profile, today);
		await insertProfileSnapshot(env, username, profile, Math.floor(Date.now() / 1000));
		profileUpdated = true;
	  }
	}

	return jsonResponse({
	  username,
	  submissions_fetched: submissions.length,
	  comments_fetched: comments.length,
	  posts_processed: processedPosts,
	  comments_processed: processedComments,
	  profile_updated: profileUpdated,
	  date: today
	});
  }

  async function handleReviewEnqueue(request: Request, env: Env): Promise<Response> {
	if (!env.DB) {
	  return jsonResponse({ error: 'DB not configured' }, 500);
	}

	if (request.method !== 'POST') {
	  return jsonResponse({ error: 'Method not allowed' }, 405);
	}

	const payload = await request.json().catch(() => null) as Record<string, any> | null;
	if (!payload || typeof payload !== 'object') {
	  return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}

	const accountId = String(payload.account_id || '').trim();
	if (!accountId) {
	  return jsonResponse({ error: 'account_id required' }, 400);
	}

	const normalizedAccountId = accountId.toLowerCase();
	const postId = payload.post_id ? String(payload.post_id).trim() : null;
	const reason = payload.reason ? String(payload.reason).trim() : null;
	const priority = Number.isFinite(payload.priority) ? Number(payload.priority) : 0;
	const now = Math.floor(Date.now() / 1000);

	const existing = await env.DB.prepare(`
	  SELECT task_id, status FROM review_tasks
	  WHERE account_id = ? AND IFNULL(post_id, '') = ? AND status IN ('pending', 'in_progress')
	  ORDER BY created_at DESC
	  LIMIT 1
	`).bind(normalizedAccountId, postId || '').first();

	if (existing) {
	  return jsonResponse({
		status: 'exists',
		task_id: existing.task_id,
		existing_status: existing.status
	  });
	}

	const result = await env.DB.prepare(`
	  INSERT INTO review_tasks (account_id, post_id, reason, priority, status, created_at, updated_at)
	  VALUES (?, ?, ?, ?, 'pending', ?, ?)
	`).bind(normalizedAccountId, postId, reason, priority, now, now).run();

	return jsonResponse({
	  status: 'queued',
	  task_id: result.meta?.last_row_id || null
	});
  }

  async function handleReviewNext(request: Request, env: Env): Promise<Response> {
	if (!env.DB) {
	  return jsonResponse({ error: 'DB not configured' }, 500);
	}

	if (request.method !== 'GET') {
	  return jsonResponse({ error: 'Method not allowed' }, 405);
	}

	const url = new URL(request.url);
	const reviewerId = url.searchParams.get('reviewer') || 'anonymous';
	const flags = parseIncludeFlags(url.searchParams.get('include'));
	const allowAuto = url.searchParams.get('auto') !== 'false';
	const now = Math.floor(Date.now() / 1000);

	let task = await env.DB.prepare(`
	  SELECT task_id, account_id, post_id, reason, priority, status, assigned_to, created_at, updated_at
	  FROM review_tasks
	  WHERE status = 'pending'
	  ORDER BY priority DESC, created_at ASC
	  LIMIT 1
	`).first() as Record<string, any> | null;

	if (!task && allowAuto) {
	  const created = await enqueueAutoReviewTask(env);
	  if (created) {
		task = await env.DB.prepare(`
		  SELECT task_id, account_id, post_id, reason, priority, status, assigned_to, created_at, updated_at
		  FROM review_tasks
		  WHERE status = 'pending'
		  ORDER BY priority DESC, created_at ASC
		  LIMIT 1
		`).first() as Record<string, any> | null;
	  }
	}

	if (!task) {
	  return jsonResponse({ status: 'empty' });
	}

	await env.DB.prepare(`
	  UPDATE review_tasks
	  SET status = 'in_progress', assigned_to = ?, updated_at = ?
	  WHERE task_id = ?
	`).bind(reviewerId, now, task.task_id).run();

	const responseTask = {
	  ...task,
	  status: 'in_progress',
	  assigned_to: reviewerId
	};

	let user: UserResponse | null = null;
	if (flags.includeSignals || flags.includeBreakdown || flags.includeProfile) {
	  const userData = await getUserData(env, String(task.account_id));
	  if (userData) {
		user = buildUserResponse(userData, flags);
	  }
	}

	let item: any = null;
	if (flags.includeItem && task.post_id) {
	  const itemRow = await env.DB.prepare(`
		SELECT * FROM items WHERE id = ? LIMIT 1
	  `).bind(task.post_id).first();
	  if (itemRow) {
		item = itemRow;
	  }
	}

	return jsonResponse({
	  status: 'ok',
	  task: responseTask,
	  user,
	  item
	});
  }

  async function handleReviewSubmit(request: Request, env: Env): Promise<Response> {
	if (!env.DB) {
	  return jsonResponse({ error: 'DB not configured' }, 500);
	}

	if (request.method !== 'POST') {
	  return jsonResponse({ error: 'Method not allowed' }, 405);
	}

	const payload = await request.json().catch(() => null) as Record<string, any> | null;
	if (!payload || typeof payload !== 'object') {
	  return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}

	const label = String(payload.label || '').trim();
	if (!label) {
	  return jsonResponse({ error: 'label required' }, 400);
	}

	const taskId = Number.isFinite(payload.task_id) ? Number(payload.task_id) : null;
	let accountId = payload.account_id ? String(payload.account_id).trim() : null;
	let postId = payload.post_id ? String(payload.post_id).trim() : null;
	const reviewerId = payload.reviewer_id ? String(payload.reviewer_id).trim() : null;
	const confidence = Number.isFinite(payload.confidence) ? Number(payload.confidence) : null;
	const notes = payload.notes ? String(payload.notes).trim() : null;
	const captureSnapshot = payload.capture_snapshot !== false;
	const now = Math.floor(Date.now() / 1000);

	if ((!accountId || !postId) && taskId) {
	  const task = await env.DB.prepare(`
		SELECT account_id, post_id FROM review_tasks WHERE task_id = ? LIMIT 1
	  `).bind(taskId).first() as { account_id?: string | null; post_id?: string | null } | null;
	  if (task) {
		if (!accountId && task.account_id) {
		  accountId = task.account_id;
		}
		if (!postId && task.post_id) {
		  postId = task.post_id;
		}
	  }
	}

	if (!accountId) {
	  return jsonResponse({ error: 'account_id required' }, 400);
	}

	const normalizedAccountId = accountId.toLowerCase();

	const result = await env.DB.prepare(`
	  INSERT INTO review_labels (task_id, account_id, post_id, label, confidence, notes, reviewer_id, created_at)
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
	  taskId,
	  normalizedAccountId,
	  postId,
	  label,
	  confidence,
	  notes,
	  reviewerId,
	  now
	).run();

	if (taskId) {
	  await env.DB.prepare(`
		UPDATE review_tasks
		SET status = 'done', updated_at = ?
		WHERE task_id = ?
	  `).bind(now, taskId).run();
	}

	let snapshotId: number | null = null;
	if (captureSnapshot) {
	  const userData = await getUserData(env, normalizedAccountId);
	  if (userData) {
		const snapshotFlags = parseIncludeFlags('signals,profile,comments,urls');
		const snapshot = buildUserResponse(userData, snapshotFlags);
		const snapshotJson = JSON.stringify({
		  captured_at: now,
		  account_id: normalizedAccountId,
		  post_id: postId,
		  user: snapshot
		});
		const featuresHash = await sha256Hex(snapshotJson);

		const snapshotResult = await env.DB.prepare(`
		  INSERT INTO review_feature_snapshots (account_id, post_id, task_id, features_hash, snapshot_json, created_at)
		  VALUES (?, ?, ?, ?, ?, ?)
		`).bind(
		  normalizedAccountId,
		  postId,
		  taskId,
		  featuresHash,
		  snapshotJson,
		  now
		).run();

		snapshotId = snapshotResult.meta?.last_row_id || null;
	  }
	}

	return jsonResponse({
	  status: 'recorded',
	  label_id: result.meta?.last_row_id || null,
	  task_id: taskId,
	  snapshot_id: snapshotId
	});
  }

  function computeHhi(counts: Record<string, number> | undefined): number {
	if (!counts) return 0;
	const entries = Object.values(counts);
	const total = entries.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
	if (total === 0) return 0;
	return entries.reduce((sum, value) => {
	  const share = (Number.isFinite(value) ? value : 0) / total;
	  return sum + (share * share);
	}, 0);
  }

  function computeCommentRatio(user: UserData): number {
	const total = (user.post_count || 0) + (user.comment_count || 0);
	if (total === 0) return 0;
	return (user.comment_count || 0) / total;
  }

  function computeHeuristicScore(user: UserData | null): { score: number; reason: string } {
	if (!user) return { score: 0, reason: 'auto: no user stats' };

	const domainHhi = computeHhi(user.domains);
	const subredditHhi = computeHhi(user.subreddits);
	const urlHhi = computeHhi(user.urls);
	const commentRatio = computeCommentRatio(user);

	let score = 0;
	const reasons: string[] = [];

	if (domainHhi >= 0.5) {
	  score += 2.0;
	  reasons.push('domain_concentration');
	}
	if (subredditHhi >= 0.5) {
	  score += 1.5;
	  reasons.push('subreddit_concentration');
	}
	if (urlHhi >= 0.5) {
	  score += 1.5;
	  reasons.push('url_reuse');
	}
	if (commentRatio < 0.2) {
	  score += 1.0;
	  reasons.push('low_comment_ratio');
	}
	if ((user.post_count || 0) >= 25) {
	  score += 0.5;
	  reasons.push('high_post_volume');
	}

	const reason = reasons.length > 0 ? 'auto: ' + reasons.join(',') : 'auto: low_signal';
	return { score, reason };
  }

  async function enqueueAutoReviewTask(env: Env): Promise<boolean> {
	if (!env.DB) return false;

	const recentCutoff = Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 30);
	const rows = await env.DB.prepare(`
	  SELECT items.id, items.account_id, items.created_utc
	  FROM items
	  LEFT JOIN review_tasks
		ON review_tasks.post_id = items.id AND review_tasks.status IN ('pending', 'in_progress')
	  LEFT JOIN review_labels
		ON review_labels.post_id = items.id
	  WHERE items.item_type = 'post'
		AND items.created_utc >= ?
		AND review_tasks.post_id IS NULL
		AND review_labels.post_id IS NULL
	  ORDER BY items.created_utc DESC
	  LIMIT 50
	`).bind(recentCutoff).all();

	const candidates = (rows.results || []) as Array<{ id: string; account_id: string }>;
	if (candidates.length === 0) return false;

	const userCache = new Map<string, UserData | null>();
	let best: { id: string; account_id: string; score: number; reason: string } | null = null;

	for (const candidate of candidates) {
	  const accountId = candidate.account_id || '';
	  if (!accountId) continue;
	  const key = accountId.toLowerCase();
	  let userData = userCache.get(key);
	  if (userData === undefined) {
		userData = await getUserData(env, key);
		userCache.set(key, userData);
	  }

	  const { score, reason } = computeHeuristicScore(userData || null);
	  if (!best || score > best.score) {
		best = { id: candidate.id, account_id: accountId, score, reason };
	  }
	}

	if (!best) return false;

	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(`
	  INSERT INTO review_tasks (account_id, post_id, reason, priority, status, created_at, updated_at)
	  VALUES (?, ?, ?, ?, 'pending', ?, ?)
	`).bind(best.account_id.toLowerCase(), best.id, best.reason, best.score, now, now).run();

	return true;
  }

  // Research Paper Content
  const RESEARCH_PAPER = `# The Concentration of Content Creation on Reddit: A Study of r/all Top Posters

[![Understanding Reddit's Content Landscape](https://img.youtube.com/vi/J7XOCG_P6o4/0.jpg)](https://www.youtube.com/watch?v=J7XOCG_P6o4)

## Abstract

This research investigates structural content concentration on Reddit's front page, specifically examining the r/all aggregation feed. The study quantifies the extent to which a small number of accounts dominate front-page visibility, then extends into account-level profiling to evaluate whether behavioral signals align with suspected coordinated, promotional, or inauthentic activity. Using a continuous data collection pipeline, we track posting and comment patterns, account behavior, and link distribution to provide empirical evidence about content concentration and potential shilling dynamics.

## 1. Introduction

### 1.1 Background and Motivation

Reddit, as a major content aggregation platform with over 50 million daily active users, presents a valuable case study for examining content concentration dynamics. The platform's architecture, which combines user voting with algorithmic curation, creates complex visibility patterns that warrant systematic investigation.

### 1.2 The Dead Internet Theory Context

The "Dead Internet Theory" suggests that a significant portion of online content is generated by automation, coordination, or commercial influence rather than by autonomous, unaffiliated individuals. While we do not attempt to prove or disprove this theory in its entirety, we examine specific aspects relevant to content concentration:

- **Automated Content Generation**: The role of bots and scripts in content creation
- **Coordinated Behavior**: Patterns suggesting organized influence operations
- **Commercial Influence**: The impact of marketing and promotional accounts
- **Platform Affordances**: How Reddit's design might amplify certain types of content

### 1.3 Research Questions

This study addresses five primary research questions:

1. **Concentration**: What proportion of front-page visibility is concentrated among the most active accounts?
2. **Patterns**: What temporal and behavioral patterns characterize high-volume contributors?
3. **Impact**: How does the composition of visible content change when filtering out the top 1,000 most frequent posters?
4. **Dynamics**: How do these patterns evolve over time and across different subreddits?
5. **Detection**: Can a model approximate expert human judgment in labeling accounts as likely shill/astroturf/fake?

## 2. Literature Review

### 2.1 Content Concentration in Digital Spaces

Previous research has documented power-law distributions in social media participation, where a small percentage of users generate the majority of content. This phenomenon has been observed across various platforms and has significant implications for content diversity and platform health.

### 2.2 Algorithmic Amplification

Platform algorithms play a crucial role in determining content visibility. Studies have shown that engagement-based ranking systems can amplify certain types of content while suppressing others, potentially creating feedback loops that reinforce existing patterns of concentration.

### 2.3 Coordinated Behavior Online

Research on coordinated inauthentic behavior has identified various patterns of manipulation, including:

- **Astroturfing**: The practice of masking sponsors of a message to make it appear as though it originates from grassroots participants
- **Sockpuppetry**: The use of multiple online identities to create the illusion of widespread support
- **Brigading**: The coordination of groups to manipulate discussions or voting patterns

## 3. Methodology

### 3.1 Data Collection

We implement a distributed data collection system using Cloudflare Workers with the following specifications:

- **Target**: r/all (Reddit's aggregate front page)
- **Sampling Strategy**: Stratified sampling across Hot, New, and Rising feeds
- **Collection Frequency**: Continuous monitoring with rate limiting to respect API guidelines
- **Data Points Captured**:
  - Post metadata (ID, title, score, comments, awards)
  - Author information (username, account age, karma)
  - Temporal data (post time, collection timestamp)
  - Subreddit context
  - Cross-posting information
  - Comment activity (volume, cadence, subreddit mix)
  - External URL distribution and reuse

### 3.2 Technical Implementation

\`\`\`mermaid
graph TD
    A[Reddit API] --> B[Cloudflare Worker]
    B --> C[Data Processing]
    C --> D[Cloudflare KV Storage]
    D --> E[Analytics Engine]
    E --> F[Visualization Dashboard]

    style A fill:#f9f,stroke:#333
    style B fill:#bbf,stroke:#333
    style C fill:#bfb,stroke:#333
    style D fill:#fbb,stroke:#333
    style E fill:#bff,stroke:#333
    style F fill:#ffb,stroke:#333
\`\`\`

### 3.3 Data Processing Pipeline

1. **Ingestion Layer**: Handles API requests, rate limiting, and error recovery
2. **Processing Layer**: Extracts and transforms relevant features from raw data
3. **Storage Layer**: Implements efficient data structures for time-series analysis
4. **Analysis Layer**: Performs statistical and network analysis

### 3.4 Analytical Framework

#### 3.4.1 Concentration Metrics
- Gini coefficient for content distribution
- Herfindahl-Hirschman Index (HHI) for market concentration
- Lorenz curve analysis of content production

#### 3.4.2 Temporal Analysis
- Time-series decomposition of posting patterns
- Periodicity detection
- Event-based analysis of posting behavior

#### 3.4.3 Network Analysis
- Bipartite network of users and subreddits
- Community detection algorithms
- Centrality measures for identifying influential accounts

### 3.5 Shill Detection Signal Set

We operationalize shill/astroturf signals as measurable behavioral features:

- **Cadence**: Hourly distribution of posts/comments and active-day ratios.
- **Focus**: Subreddit and domain concentration (HHI), topic narrowness, and repeated URL patterns.
- **Content Mix**: Post-type ratios (self/link/image/video/crosspost).
- **Engagement Profile**: Comment ratio and karma distribution.
- **Cross-Account Links**: Shared external URLs across multiple accounts.

These signals are used for model training and for manual review workflows.

### 3.6 Labeling Workflow

Human judgment is encoded as labels to train and evaluate models. Labels use three classes:

- **likely_shill**
- **likely_organic**
- **unclear**

Labels include confidence and notes to capture reasoning. This builds a growing ground-truth dataset aligned with the author's intuition.

For consistent labeling, use the rubric in docs/labeling-rubric.md. The game maps "Yes" to likely_shill and "No" to likely_organic, while unclear is reserved for ambiguous cases or manual review.

## 4. Results (Preliminary)

### 4.1 Data Overview
- Total accounts tracked: 610
- Time period: [Start date] - [Current date]
- Total posts analyzed: [Number]

### 4.2 Content Concentration
- Top 1% of accounts account for X% of front-page appearances
- Gini coefficient of content production: [Value]
- HHI score: [Value] (indicating [market concentration level])

### 4.3 Temporal Patterns
- Peak posting times and days
- Patterns of coordinated posting
- Changes in concentration over time

### 4.4 Network Analysis
- Subreddit cross-posting patterns
- Account clustering based on posting behavior
- Identification of potential coordination networks

## 5. Discussion

### 5.1 Implications for Platform Design
- How platform features might contribute to content concentration
- Potential design interventions to improve content diversity

### 5.2 Limitations
- Data collection constraints
- API limitations
- Challenges in distinguishing between organic and inorganic behavior

### 5.3 Future Work
- Expansion to other platforms
- Development of real-time detection systems
- Longitudinal studies of content concentration

## 6. Conclusion

This ongoing research provides a framework for understanding content concentration on Reddit and its implications. Our preliminary findings suggest that [key findings]. Future work will focus on [next steps].

## 7. References

[To be completed with academic citations]

## 8. Appendices

### 8.1 Data Collection Code
[Link to relevant code sections]

### 8.2 Analysis Scripts
[Link to analysis code]

### 8.3 Data Dictionary
[Detailed description of all collected metrics]

## The Block List Hypothesis

Reddit allows users to block up to 1,000 accounts. We hypothesize that strategically blocking the top 1,000 most prolific posters would:

1. **Reduce Low-Quality Content**: Remove reposted or karma-farmed content
2. **Increase Content Diversity**: Surface posts from less active, potentially more authentic users
3. **Improve Experience**: Create a more "human" feeling feed
4. **Reveal Hidden Content**: Make room for posts that would otherwise be crowded out

### Experimental Design (Proposed)

1. Generate daily block lists of top 1,000 posters
2. Recruit volunteer users to apply block lists
3. Survey users on content quality perception
4. Compare engagement metrics with control group

## Implications

### For Users

Understanding content concentration empowers users to:
- Make informed decisions about their Reddit experience
- Use blocking strategically to customize their feed
- Identify and avoid manipulated content

### For Platform Health

This research may illuminate:
- The effectiveness of current anti-spam measures
- The prevalence of commercial activity disguised as organic
- The gap between perceived and actual user-generated content

### For Digital Literacy

Broader implications include:
- Understanding authenticity challenges on social platforms
- Recognizing patterns of coordinated inauthentic behavior
- Developing tools for healthier online experiences

## Contributing

This is an open-source research project. We welcome contributions in:

- **Data Analysis**: Statistical analysis of collected data
- **Visualization**: Dashboards and charts
- **Research Writing**: Expanding this paper with findings
- **Code Improvements**: Efficiency, accuracy, new metrics
- **Peer Review**: Methodology critique and suggestions

### How to Contribute

1. Fork the repository
2. Create a feature branch
3. Submit a pull request with clear description
4. Join discussions in Issues

## Limitations

1. **API Rate Limits**: Sampling is constrained by Reddit's API limits
2. **Observable Bias**: Only tracks posts that reach r/all
3. **No Account Age**: Cannot determine account creation dates via public API
4. **Attribution Uncertainty**: Cannot definitively prove automation

## Future Work

1. **Sentiment Analysis**: Categorize content types from top posters
2. **Network Analysis**: Map relationships between high-volume accounts
3. **Temporal Deep Dive**: Hourly posting pattern analysis
4. **Cross-Platform**: Compare with similar studies on other platforms
5. **User Study**: Controlled experiment with volunteer block list users

## Authors

- **u/tankyspanky** - Project Lead, Data Analysis

## License

MIT License - See LICENSE file for details.
`;

  async function handleStats(env: Env): Promise<Response> {
	try {
	  let totalUsers = 0;
	  let cursor: string | undefined;

	  do {
		const list: any = await env.REDDIT_USERS.list({ cursor, prefix: 'user_' });
		totalUsers += list.keys.length;
		cursor = list.cursor;
	  } while (cursor);

	  const today = new Date().toISOString().split('T')[0];
	  const lastCollected = await env.REDDIT_CONFIG.get(`last_${today}`);
	  const collectionsToday = parseInt(await env.REDDIT_CONFIG.get(`collections_${today}`) || '0');

	  // Determine status based on activity
	  let status = 'pending';
	  if (lastCollected) {
		status = 'complete';
	  } else if (collectionsToday > 0) {
		status = 'active'; // In progress / incremental
	  }

	  // Get latest top list count
	  const latestData = await env.REDDIT_TOP_LISTS.get('latest');
	  const topCount = latestData ? (JSON.parse(latestData) as TopUser[]).length : 0;

	  const response: StatsResponse = {
		total_users: totalUsers,
		top_count: topCount,
		collection_status: status,
		last_collection: lastCollected || (collectionsToday > 0 ? new Date().toISOString() : null), // Show activity time if active
		date: today,
		system: 'Reddit Top Posters Tracker'
	  };

	  return jsonResponse(response);

	} catch (error) {
	  console.error('Error getting stats:', error);
	  return jsonResponse({ error: 'Failed to get stats' }, 500);
	}
  }
