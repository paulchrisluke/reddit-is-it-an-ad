#!/usr/bin/env node
'use strict';

const fs = require('fs');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BASE_URL = process.env.REDDIT_TRACKER_BASE_URL || 'http://localhost:8787';
const USERNAME_RE = /[A-Za-z0-9_-]{3,20}/g;

function printUsage() {
	console.log([
		'Analyze blocked accounts using the reddit-tracker API.',
		'',
		'Usage:',
		'  node scripts/analyze-blocked-accounts.js --base-url https://your-worker.workers.dev --file blocked-accounts.txt',
		'  node scripts/analyze-blocked-accounts.js --base-url http://localhost:8787 --stdin',
		'  node scripts/analyze-blocked-accounts.js --base-url http://localhost:8787 GallowBoob TooShiftyForYou',
		'',
		'Options:',
		'  --base-url <url>     Base URL for the worker API (default: http://localhost:8787)',
		'  --file <path>        Text file with usernames (one per line or pasted list)',
		'  --stdin              Read usernames from stdin',
		'  --users <list>        Comma-separated usernames',
		'  --seed               Seed data for each username via /api/collect-user',
		'  --seed-limit <n>      Max submissions per user when seeding (default: 100)',
		'  --seed-pages <n>      Max pages per user when seeding (default: 2)',
		'  --no-seed-profile     Skip profile fetch during seeding',
		'  --no-seed-comments    Skip comment collection during seeding',
		'  --format <text|json>  Output format (default: text)',
		'  --top <n>             Top N subreddits/domains to show (default: 3)',
		'  --concurrency <n>     Concurrent requests (default: 5)',
		'  -h, --help            Show this help',
	].join('\n'));
}

function parseArgs(argv) {
	const args = {
		baseUrl: DEFAULT_BASE_URL,
		file: null,
		stdin: false,
		users: [],
		seed: false,
		seedLimit: 100,
		seedPages: 2,
		seedProfile: true,
		seedComments: true,
		format: 'text',
		top: 3,
		concurrency: 5,
		help: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--base-url') {
			args.baseUrl = argv[++i];
			continue;
		}
		if (arg === '--file' || arg === '-f') {
			args.file = argv[++i];
			continue;
		}
		if (arg === '--stdin') {
			args.stdin = true;
			continue;
		}
		if (arg === '--users' || arg === '-u') {
			args.users.push(argv[++i]);
			continue;
		}
		if (arg === '--seed') {
			args.seed = true;
			continue;
		}
		if (arg === '--seed-limit') {
			args.seedLimit = Number.parseInt(argv[++i], 10);
			continue;
		}
		if (arg === '--seed-pages') {
			args.seedPages = Number.parseInt(argv[++i], 10);
			continue;
		}
		if (arg === '--no-seed-profile') {
			args.seedProfile = false;
			continue;
		}
		if (arg === '--no-seed-comments') {
			args.seedComments = false;
			continue;
		}
		if (arg === '--format') {
			args.format = argv[++i];
			continue;
		}
		if (arg === '--top') {
			args.top = Number.parseInt(argv[++i], 10);
			continue;
		}
		if (arg === '--concurrency') {
			args.concurrency = Number.parseInt(argv[++i], 10);
			continue;
		}
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			continue;
		}
		args.users.push(arg);
	}

	return args;
}

function extractUsernamesFromText(text) {
	const matches = text.match(USERNAME_RE) || [];
	return normalizeUsernames(matches);
}

function normalizeUsernames(list) {
	const seen = new Set();
	const result = [];

	for (const entry of list) {
		if (!entry) continue;
		const tokens = String(entry).match(USERNAME_RE) || [];
		for (const token of tokens) {
			if (!token || token.toLowerCase() === 'unblock') continue;
			const lower = token.toLowerCase();
			if (seen.has(lower)) continue;
			seen.add(lower);
			result.push(token);
		}
	}

	return result;
}

function summarizeCounts(counts, topN) {
	const entries = Object.entries(counts || {});
	const total = entries.reduce((sum, [, count]) => sum + (Number.isFinite(count) ? count : 0), 0);
	const sorted = entries.sort((a, b) => b[1] - a[1]);
	const top = sorted.slice(0, topN).map(([name, count]) => ({
		name,
		count,
		share: total > 0 ? count / total : 0
	}));
	const hhi = total > 0
		? sorted.reduce((sum, [, count]) => {
			const share = count / total;
			return sum + share * share;
		}, 0)
		: 0;

	return {
		total,
		distinct: entries.length,
		top,
		hhi
	};
}

function formatPercent(value) {
	if (!Number.isFinite(value)) return 'n/a';
	return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 2) {
	if (!Number.isFinite(value)) return 'n/a';
	const text = value.toFixed(digits);
	return text.replace(/\.00$/, '');
}

function formatTopList(items) {
	if (!items || items.length === 0) return 'n/a';
	return items
		.map((item) => `${item.name} ${formatPercent(item.share)} (${item.count})`)
		.join(', ');
}

function formatUrl(value, maxLength = 80) {
	if (!value) return 'n/a';
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function parseDate(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function calculateSpanDays(firstSeen, lastUpdated) {
	const first = parseDate(firstSeen);
	const last = parseDate(lastUpdated);
	if (!first || !last) return null;
	const diff = last.getTime() - first.getTime();
	if (diff < 0) return null;
	return Math.max(1, Math.ceil(diff / DAY_MS) + 1);
}

function calculateAccountAgeDays(createdUtc) {
	if (!Number.isFinite(createdUtc)) return null;
	const nowSeconds = Date.now() / 1000;
	const diff = nowSeconds - createdUtc;
	if (diff <= 0) return null;
	return Math.floor(diff / (24 * 60 * 60));
}

function collectMissingSignals(data) {
	const missing = [];
	if (!data.profile || !Number.isFinite(data.profile.created_utc)) {
		missing.push('account_age');
	}
	if (!data.hourly_posts || Object.keys(data.hourly_posts).length === 0) {
		missing.push('hourly_distribution');
	}
	if (!data.post_types || Object.keys(data.post_types).length === 0) {
		missing.push('post_type_mix');
	}
	if (!data.subreddits || Object.keys(data.subreddits).length === 0) {
		missing.push('subreddit_mix');
	}
	if (!data.domains || Object.keys(data.domains).length === 0) {
		missing.push('domain_mix');
	}
	if (!data.urls || Object.keys(data.urls).length === 0) {
		missing.push('url_mix');
	}
	if (!data.comment_subreddits || Object.keys(data.comment_subreddits).length === 0) {
		missing.push('comment_mix');
	}
	if (!data.hourly_comments || Object.keys(data.hourly_comments).length === 0) {
		missing.push('comment_hourly_distribution');
	}
	return missing;
}

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'reddit-tracker-blocked-analysis/1.0' }
	});

	if (!response.ok) {
		const error = new Error(`Request failed: ${response.status} ${response.statusText}`);
		error.status = response.status;
		error.body = await response.text();
		throw error;
	}

	return response.json();
}

async function seedUser(username, baseUrl, limit, pages, seedProfile, seedComments) {
	const params = new URLSearchParams({
		username,
		limit: String(limit),
		pages: String(pages),
		comments: seedComments ? 'true' : 'false'
	});
	if (!seedProfile) {
		params.set('profile', 'false');
	}
	const url = `${baseUrl}/api/collect-user?${params.toString()}`;
	return fetchJson(url);
}

async function analyzeUser(username, baseUrl, topMap, topN) {
	const lower = username.toLowerCase();
	const topEntry = topMap.get(lower) || null;
	const url = `${baseUrl}/api/user?username=${encodeURIComponent(username)}&include=signals,profile`;

	try {
		const data = await fetchJson(url);
		const activity = data.recent_activity || {};
		const activeDays = Object.keys(activity).length;
		const spanDays = calculateSpanDays(data.first_seen, data.last_updated);
		const activeRatio = spanDays ? activeDays / spanDays : null;
		const subredditSummary = summarizeCounts(data.subreddits || {}, topN);
		const domainSummary = summarizeCounts(data.domains || {}, topN);
		const hourlySummary = summarizeCounts(data.hourly_posts || {}, topN);
		const postTypeSummary = summarizeCounts(data.post_types || {}, topN);
		const commentSubSummary = summarizeCounts(data.comment_subreddits || {}, topN);
		const commentHourlySummary = summarizeCounts(data.hourly_comments || {}, topN);
		const urlSummary = summarizeCounts(data.urls || {}, topN);
		const accountAgeDays = calculateAccountAgeDays(data.profile?.created_utc);
		const missingSignals = collectMissingSignals(data);
		const totalItems = (data.post_count || 0) + (data.comment_count || 0);
		const commentRatio = totalItems > 0 ? (data.comment_count || 0) / totalItems : 0;

		return {
			username,
			status: 'found',
			top_rank: topEntry ? topEntry.rank : null,
			top_subreddit: topEntry ? topEntry.top_subreddit : null,
			post_count: data.post_count,
			comment_count: data.comment_count || 0,
			daily_average: data.daily_average,
			total_karma: data.total_karma,
			first_seen: data.first_seen,
			last_updated: data.last_updated,
			active_days: activeDays,
			span_days: spanDays,
			active_ratio: activeRatio,
			comment_ratio: commentRatio,
			comment_score: data.comment_score || 0,
			subreddits: subredditSummary,
			domains: domainSummary,
			hourly: hourlySummary,
			post_types: postTypeSummary,
			comment_subreddits: commentSubSummary,
			comment_hourly: commentHourlySummary,
			urls: urlSummary,
			url_values: data.urls || {},
			profile: data.profile || null,
			account_age_days: accountAgeDays,
			missing_signals: missingSignals
		};
	} catch (error) {
		return {
			username,
			status: error.status === 404 ? 'not_found' : 'error',
			error: error.message,
			top_rank: topEntry ? topEntry.rank : null,
			top_subreddit: topEntry ? topEntry.top_subreddit : null
		};
	}
}

function renderText(results, topListError) {
	if (topListError) {
		console.warn(`Warning: failed to load top poster list (${topListError.message}).`);
	}

	for (const result of results) {
		console.log(`User: ${result.username}`);
		if (result.top_rank) {
			console.log(`  top_rank: ${result.top_rank} (top_subreddit: ${result.top_subreddit || 'n/a'})`);
		}

		if (result.status !== 'found') {
			console.log(`  status: ${result.status}`);
			if (result.error) {
				console.log(`  error: ${result.error}`);
			}
			console.log('');
			continue;
		}

		console.log(`  posts: ${result.post_count} | daily_avg: ${formatNumber(result.daily_average)} | total_karma: ${result.total_karma}`);
		console.log(`  comments: ${result.comment_count} | comment_ratio: ${formatPercent(result.comment_ratio)} | comment_score: ${formatNumber(result.comment_score)}`);
		console.log(`  active_days: ${result.active_days}${result.span_days ? `/${result.span_days}` : ''} | first_seen: ${result.first_seen} | last_updated: ${result.last_updated}`);
		if (result.profile) {
			const accountAge = result.account_age_days !== null ? `${result.account_age_days}d` : 'n/a';
			const linkKarma = Number.isFinite(result.profile.link_karma) ? result.profile.link_karma : 'n/a';
			const commentKarma = Number.isFinite(result.profile.comment_karma) ? result.profile.comment_karma : 'n/a';
			console.log(`  account_age: ${accountAge} | link_karma: ${linkKarma} | comment_karma: ${commentKarma}`);
		}
		console.log(`  subreddits: distinct=${result.subreddits.distinct}, hhi=${formatNumber(result.subreddits.hhi)} | top=${formatTopList(result.subreddits.top)}`);
		console.log(`  domains: distinct=${result.domains.distinct}, hhi=${formatNumber(result.domains.hhi)} | top=${formatTopList(result.domains.top)}`);
		console.log(`  urls: distinct=${result.urls.distinct}, hhi=${formatNumber(result.urls.hhi)} | top=${formatTopList(result.urls.top)}`);
		if (Number.isFinite(result.shared_url_ratio)) {
			console.log(`  shared_urls: ${result.shared_url_count}/${result.urls.distinct} (${formatPercent(result.shared_url_ratio)})`);
		}
		console.log(`  post_types: distinct=${result.post_types.distinct}, hhi=${formatNumber(result.post_types.hhi)} | top=${formatTopList(result.post_types.top)}`);
		console.log(`  hourly: distinct=${result.hourly.distinct}, hhi=${formatNumber(result.hourly.hhi)} | top=${formatTopList(result.hourly.top)}`);
		console.log(`  comment_subreddits: distinct=${result.comment_subreddits.distinct}, hhi=${formatNumber(result.comment_subreddits.hhi)} | top=${formatTopList(result.comment_subreddits.top)}`);
		console.log(`  comment_hourly: distinct=${result.comment_hourly.distinct}, hhi=${formatNumber(result.comment_hourly.hhi)} | top=${formatTopList(result.comment_hourly.top)}`);
		if (result.missing_signals && result.missing_signals.length > 0) {
			console.log(`  missing_signals: ${result.missing_signals.join(', ')}`);
		}
		console.log('');
	}
}

function renderCoverageSummary(results) {
	const found = results.filter((result) => result.status === 'found');
	if (found.length === 0) return;

	const signals = [
		'account_age',
		'hourly_distribution',
		'post_type_mix',
		'subreddit_mix',
		'domain_mix',
		'url_mix',
		'comment_mix',
		'comment_hourly_distribution'
	];
	const coverage = Object.fromEntries(signals.map((signal) => [signal, 0]));

	for (const result of found) {
		const missing = new Set(result.missing_signals || []);
		for (const signal of signals) {
			if (!missing.has(signal)) {
				coverage[signal] += 1;
			}
		}
	}

	console.log('Coverage summary:');
	for (const signal of signals) {
		console.log(`  ${signal}: ${coverage[signal]}/${found.length}`);
	}
	console.log('');
}

function renderSharedUrlSummary(summary, limit = 10) {
	if (!summary || !summary.shared_urls || summary.shared_urls.length === 0) return;
	console.log(`Shared URL summary (top ${limit}):`);
	for (const entry of summary.shared_urls.slice(0, limit)) {
		console.log(`  ${formatUrl(entry.url)} | accounts=${entry.user_count} | total=${entry.total_count}`);
	}
	console.log('');
}

function computeSharedUrls(results) {
	const urlMap = new Map();

	for (const result of results) {
		if (result.status !== 'found') continue;
		const urls = result.url_values || {};
		for (const [url, count] of Object.entries(urls)) {
			if (!url) continue;
			const entry = urlMap.get(url) || { users: new Set(), count: 0 };
			entry.users.add(result.username);
			entry.count += Number.isFinite(count) ? count : 0;
			urlMap.set(url, entry);
		}
	}

	const sharedUrls = [];
	for (const [url, entry] of urlMap.entries()) {
		if (entry.users.size < 2) continue;
		sharedUrls.push({
			url,
			user_count: entry.users.size,
			total_count: entry.count
		});
	}

	sharedUrls.sort((a, b) => {
		if (b.user_count !== a.user_count) return b.user_count - a.user_count;
		return b.total_count - a.total_count;
	});

	const sharedSet = new Set(sharedUrls.map((entry) => entry.url));
	for (const result of results) {
		if (result.status !== 'found') continue;
		const urls = result.url_values || {};
		const distinct = Object.keys(urls).length;
		let sharedCount = 0;
		for (const url of Object.keys(urls)) {
			if (sharedSet.has(url)) sharedCount += 1;
		}
		result.shared_url_count = sharedCount;
		result.shared_url_ratio = distinct > 0 ? sharedCount / distinct : 0;
	}

	return { shared_urls: sharedUrls, shared_total: sharedUrls.length };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printUsage();
		return;
	}

	let usernames = [];

	if (args.file) {
		const text = fs.readFileSync(args.file, 'utf8');
		usernames = usernames.concat(extractUsernamesFromText(text));
	}

	if (args.stdin) {
		const text = fs.readFileSync(0, 'utf8');
		usernames = usernames.concat(extractUsernamesFromText(text));
	}

	if (args.users.length > 0) {
		usernames = usernames.concat(normalizeUsernames(args.users.join(',').split(',')));
	}

	if (usernames.length === 0) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	const topMap = new Map();
	let topListError = null;

	try {
		const topList = await fetchJson(`${baseUrl}/api/top-posters?limit=1000&offset=0`);
		if (topList && Array.isArray(topList.users)) {
			for (const entry of topList.users) {
				if (!entry || !entry.username) continue;
				topMap.set(entry.username.toLowerCase(), entry);
			}
		}
	} catch (error) {
		topListError = error;
	}

	if (args.seed) {
		const seedLimit = Number.isFinite(args.seedLimit) && args.seedLimit > 0 ? args.seedLimit : 100;
		const seedPages = Number.isFinite(args.seedPages) && args.seedPages > 0 ? args.seedPages : 2;
		const seedBatchSize = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 5;
		console.log(`Seeding ${usernames.length} users (limit=${seedLimit}, pages=${seedPages})...`);

		for (let i = 0; i < usernames.length; i += seedBatchSize) {
			const batch = usernames.slice(i, i + seedBatchSize);
			await Promise.all(batch.map((user) =>
				seedUser(user, baseUrl, seedLimit, seedPages, args.seedProfile, args.seedComments).catch((error) => ({
					username: user,
					error: error.message
				}))
			));
		}
	}

	const results = [];
	const batchSize = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 5;

	for (let i = 0; i < usernames.length; i += batchSize) {
		const batch = usernames.slice(i, i + batchSize);
		const batchResults = await Promise.all(batch.map((user) => analyzeUser(user, baseUrl, topMap, args.top)));
		results.push(...batchResults);
	}

	const sharedSummary = computeSharedUrls(results);

	if (args.format === 'json') {
		console.log(JSON.stringify({ results, shared_summary: sharedSummary }, null, 2));
		return;
	}

	renderText(results, topListError);
	renderCoverageSummary(results);
	renderSharedUrlSummary(sharedSummary);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
