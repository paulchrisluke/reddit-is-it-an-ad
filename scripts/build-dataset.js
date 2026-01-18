#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BASE_URL = process.env.REDDIT_TRACKER_BASE_URL || 'http://localhost:8787';
const USERNAME_RE = /[A-Za-z0-9_-]{3,20}/g;

function printUsage() {
	console.log([
		'Build a labeled dataset from reddit-tracker user signals.',
		'',
		'Usage:',
		'  node scripts/build-dataset.js --base-url http://localhost:8787 --file tankyspanky-block-list.json --output datasets/shill-dataset.jsonl',
		'  node scripts/build-dataset.js --base-url http://localhost:8787 --stdin --labels labels.json',
		'',
		'Options:',
		'  --base-url <url>     Base URL for the worker API (default: http://localhost:8787)',
		'  --file <path>        Text file with usernames (one per line or pasted list)',
		'  --stdin              Read usernames from stdin',
		'  --users <list>        Comma-separated usernames',
		'  --labels <path>       JSON labels file (map or array)',
		'  --output <path>       Output JSONL path (default: datasets/shill-dataset.jsonl)',
		'  --seed               Seed data for each username via /api/collect-user',
		'  --seed-limit <n>      Max submissions per user when seeding (default: 100)',
		'  --seed-pages <n>      Max pages per user when seeding (default: 2)',
		'  --no-seed-profile     Skip profile fetch during seeding',
		'  --no-seed-comments    Skip comment collection during seeding',
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
		labels: null,
		output: 'datasets/shill-dataset.jsonl',
		seed: false,
		seedLimit: 100,
		seedPages: 2,
		seedProfile: true,
		seedComments: true,
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
		if (arg === '--labels') {
			args.labels = argv[++i];
			continue;
		}
		if (arg === '--output' || arg === '-o') {
			args.output = argv[++i];
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

function summarizeCounts(counts) {
	const entries = Object.entries(counts || {});
	const total = entries.reduce((sum, [, count]) => sum + (Number.isFinite(count) ? count : 0), 0);
	const sorted = entries.sort((a, b) => b[1] - a[1]);
	const hhi = total > 0
		? sorted.reduce((sum, [, count]) => {
			const share = count / total;
			return sum + share * share;
		}, 0)
		: 0;

	return {
		total,
		distinct: entries.length,
		hhi,
		top: sorted[0] ? { name: sorted[0][0], count: sorted[0][1], share: sorted[0][1] / total } : null
	};
}

function calculateSpanDays(firstSeen, lastUpdated) {
	const first = new Date(firstSeen);
	const last = new Date(lastUpdated);
	if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
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

function loadLabels(labelsPath) {
	if (!labelsPath) return new Map();
	const raw = fs.readFileSync(labelsPath, 'utf8');
	const data = JSON.parse(raw);
	const labels = new Map();

	if (Array.isArray(data)) {
		for (const entry of data) {
			if (!entry || !entry.username) continue;
			labels.set(String(entry.username).toLowerCase(), {
				label: entry.label,
				confidence: entry.confidence,
				notes: entry.notes
			});
		}
		return labels;
	}

	if (data && typeof data === 'object') {
		for (const [username, value] of Object.entries(data)) {
			if (!username) continue;
			if (value && typeof value === 'object') {
				labels.set(String(username).toLowerCase(), {
					label: value.label,
					confidence: value.confidence,
					notes: value.notes
				});
			} else {
				labels.set(String(username).toLowerCase(), { label: value });
			}
		}
	}

	return labels;
}

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'reddit-tracker-dataset-builder/1.0' }
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

async function fetchUserSignals(username, baseUrl) {
	const url = `${baseUrl}/api/user?username=${encodeURIComponent(username)}&include=signals,profile`;
	return fetchJson(url);
}

function computeSharedUrlMap(results) {
	const urlMap = new Map();

	for (const result of results) {
		if (!result || !result.urls) continue;
		for (const [url, count] of Object.entries(result.urls)) {
			if (!url) continue;
			const entry = urlMap.get(url) || { users: new Set(), count: 0 };
			entry.users.add(result.username);
			entry.count += Number.isFinite(count) ? count : 0;
			urlMap.set(url, entry);
		}
	}

	const sharedSet = new Set();
	for (const [url, entry] of urlMap.entries()) {
		if (entry.users.size >= 2) sharedSet.add(url);
	}

	return sharedSet;
}

function buildFeatureRow(username, data, sharedUrls, labelsMap) {
	const subredditSummary = summarizeCounts(data.subreddits || {});
	const domainSummary = summarizeCounts(data.domains || {});
	const postTypeSummary = summarizeCounts(data.post_types || {});
	const hourlySummary = summarizeCounts(data.hourly_posts || {});
	const urlSummary = summarizeCounts(data.urls || {});
	const commentSubSummary = summarizeCounts(data.comment_subreddits || {});
	const commentHourlySummary = summarizeCounts(data.hourly_comments || {});
	const spanDays = calculateSpanDays(data.first_seen, data.last_updated);
	const activeDays = Object.keys(data.recent_activity || {}).length;
	const activeRatio = spanDays ? activeDays / spanDays : 0;
	const totalItems = (data.post_count || 0) + (data.comment_count || 0);
	const commentRatio = totalItems > 0 ? (data.comment_count || 0) / totalItems : 0;
	const accountAgeDays = calculateAccountAgeDays(data.profile?.created_utc);
	const urlsDistinct = Object.keys(data.urls || {}).length;
	let sharedUrlCount = 0;
	for (const url of Object.keys(data.urls || {})) {
		if (sharedUrls.has(url)) sharedUrlCount += 1;
	}

	const labels = labelsMap.get(username.toLowerCase());

	const flags = {
		low_comment_ratio: commentRatio < 0.2,
		high_comment_ratio: commentRatio >= 0.8,
		high_domain_concentration: domainSummary.hhi >= 0.5,
		high_subreddit_concentration: subredditSummary.hhi >= 0.5,
		high_url_reuse: urlsDistinct > 0 && (sharedUrlCount / urlsDistinct) >= 0.2,
		high_post_focus: subredditSummary.top ? subredditSummary.top.share >= 0.6 : false,
		low_account_age: accountAgeDays !== null ? accountAgeDays < 180 : false
	};

	const row = {
		username,
		label: labels?.label,
		label_confidence: labels?.confidence,
		label_notes: labels?.notes,
		features: {
			post_count: data.post_count || 0,
			comment_count: data.comment_count || 0,
			post_score_total: data.total_karma || 0,
			comment_score: data.comment_score || 0,
			comment_ratio: commentRatio,
			daily_average: data.daily_average || 0,
			active_ratio: activeRatio,
			span_days: spanDays,
			active_days: activeDays,
			account_age_days: accountAgeDays,
			link_karma: data.profile?.link_karma ?? null,
			comment_karma: data.profile?.comment_karma ?? null,
			is_mod: data.profile?.is_mod ?? null,
			is_gold: data.profile?.is_gold ?? null,
			has_verified_email: data.profile?.has_verified_email ?? null,
			subreddit_distinct: subredditSummary.distinct,
			subreddit_hhi: subredditSummary.hhi,
			subreddit_top_share: subredditSummary.top ? subredditSummary.top.share : 0,
			domain_distinct: domainSummary.distinct,
			domain_hhi: domainSummary.hhi,
			domain_top_share: domainSummary.top ? domainSummary.top.share : 0,
			post_type_distinct: postTypeSummary.distinct,
			post_type_hhi: postTypeSummary.hhi,
			hourly_distinct: hourlySummary.distinct,
			hourly_hhi: hourlySummary.hhi,
			comment_subreddit_distinct: commentSubSummary.distinct,
			comment_subreddit_hhi: commentSubSummary.hhi,
			comment_hourly_distinct: commentHourlySummary.distinct,
			comment_hourly_hhi: commentHourlySummary.hhi,
			url_distinct: urlsDistinct,
			url_hhi: urlSummary.hhi,
			shared_url_distinct: sharedUrlCount,
			shared_url_ratio: urlsDistinct > 0 ? sharedUrlCount / urlsDistinct : 0
		},
		flags
	};

	return row;
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
	const labelsMap = loadLabels(args.labels);

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
		const batchResults = await Promise.all(batch.map((user) =>
			fetchUserSignals(user, baseUrl).then((data) => ({ username: user, data })).catch((error) => ({
				username: user,
				error
			}))
		));
		results.push(...batchResults);
	}

	const validResults = results.filter((entry) => entry.data);
	const sharedUrls = computeSharedUrlMap(validResults.map((entry) => ({
		username: entry.username,
		urls: entry.data.urls || {}
	})));

	const rows = validResults.map((entry) => buildFeatureRow(entry.username, entry.data, sharedUrls, labelsMap));

	if (args.output === '-' || args.output === '/dev/stdout') {
		for (const row of rows) {
			console.log(JSON.stringify(row));
		}
		return;
	}

	fs.mkdirSync(path.dirname(args.output), { recursive: true });
	const stream = fs.createWriteStream(args.output, { encoding: 'utf8' });
	for (const row of rows) {
		stream.write(`${JSON.stringify(row)}\n`);
	}
	stream.end();

	console.log(`Wrote ${rows.length} rows to ${args.output}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
