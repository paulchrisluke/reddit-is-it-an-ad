#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_BASE_URL = process.env.REDDIT_TRACKER_BASE_URL || 'http://localhost:8787';
const USERNAME_RE = /[A-Za-z0-9_-]{3,20}/g;

function printUsage() {
	console.log([
		'Interactive review queue for labeling Reddit accounts.',
		'',
		'Usage:',
		'  node scripts/review-queue.js --base-url http://localhost:8787 --file tankyspanky-block-list.json --labels labels.json',
		'',
		'Options:',
		'  --base-url <url>     Base URL for the worker API (default: http://localhost:8787)',
		'  --file <path>        Text file with usernames (one per line or pasted list)',
		'  --stdin              Read usernames from stdin',
		'  --users <list>        Comma-separated usernames',
		'  --labels <path>       Labels JSON file (default: labels.json)',
		'  --include-labeled     Review users even if already labeled',
		'  --seed               Seed data for each username via /api/collect-user',
		'  --seed-limit <n>      Max submissions per user when seeding (default: 100)',
		'  --seed-pages <n>      Max pages per user when seeding (default: 2)',
		'  --no-seed-profile     Skip profile fetch during seeding',
		'  --no-seed-comments    Skip comment collection during seeding',
		'  --concurrency <n>     Concurrent requests (default: 3)',
		'  -h, --help            Show this help',
	].join('\n'));
}

function parseArgs(argv) {
	const args = {
		baseUrl: DEFAULT_BASE_URL,
		file: null,
		stdin: false,
		users: [],
		labels: 'labels.json',
		includeLabeled: false,
		seed: false,
		seedLimit: 100,
		seedPages: 2,
		seedProfile: true,
		seedComments: true,
		concurrency: 3,
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
		if (arg === '--include-labeled') {
			args.includeLabeled = true;
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

function loadLabels(filePath) {
	if (!fs.existsSync(filePath)) return {};
	const raw = fs.readFileSync(filePath, 'utf8');
	if (!raw.trim()) return {};
	return JSON.parse(raw);
}

function writeLabels(filePath, labels) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(labels, null, 2));
}

function summarizeCounts(counts) {
	const entries = Object.entries(counts || {});
	const total = entries.reduce((sum, [, count]) => sum + (Number.isFinite(count) ? count : 0), 0);
	const sorted = entries.sort((a, b) => b[1] - a[1]);
	const top = sorted[0] ? { name: sorted[0][0], count: sorted[0][1], share: sorted[0][1] / total } : null;
	const hhi = total > 0
		? sorted.reduce((sum, [, count]) => {
			const share = count / total;
			return sum + share * share;
		}, 0)
		: 0;

	return { total, distinct: entries.length, top, hhi };
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

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'reddit-tracker-review-queue/1.0' }
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

async function prompt(rl, text) {
	return new Promise((resolve) => {
		rl.question(text, (answer) => resolve(answer.trim()));
	});
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
	const labelsPath = args.labels || 'labels.json';
	const labels = loadLabels(labelsPath);

	if (args.seed) {
		const seedLimit = Number.isFinite(args.seedLimit) && args.seedLimit > 0 ? args.seedLimit : 100;
		const seedPages = Number.isFinite(args.seedPages) && args.seedPages > 0 ? args.seedPages : 2;
		const seedBatchSize = Number.isFinite(args.concurrency) && args.concurrency > 0 ? args.concurrency : 3;
		console.log(`Seeding ${usernames.length} users (limit=${seedLimit}, pages=${seedPages})...`);
		for (let i = 0; i < usernames.length; i += seedBatchSize) {
			const batch = usernames.slice(i, i + seedBatchSize);
			await Promise.all(batch.map((user) =>
				seedUser(user, baseUrl, seedLimit, seedPages, args.seedProfile, args.seedComments).catch(() => null)
			));
		}
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	for (const username of usernames) {
		if (!args.includeLabeled && labels[username]) {
			continue;
		}

		let data;
		try {
			data = await fetchUserSignals(username, baseUrl);
		} catch (error) {
			console.log(`User: ${username} (not found or error)`);
			const action = await prompt(rl, 'Skip (s) or quit (q)? ');
			if (action.toLowerCase() === 'q') break;
			continue;
		}

		const totalItems = (data.post_count || 0) + (data.comment_count || 0);
		const commentRatio = totalItems > 0 ? (data.comment_count || 0) / totalItems : 0;
		const subredditSummary = summarizeCounts(data.subreddits || {});
		const domainSummary = summarizeCounts(data.domains || {});
		const postTypeSummary = summarizeCounts(data.post_types || {});
		const urlSummary = summarizeCounts(data.urls || {});
		const commentSubSummary = summarizeCounts(data.comment_subreddits || {});

		console.log('');
		console.log(`User: ${username}`);
		console.log(`  posts: ${data.post_count || 0} | comments: ${data.comment_count || 0} | comment_ratio: ${formatPercent(commentRatio)}`);
		console.log(`  daily_avg: ${formatNumber(data.daily_average)} | total_post_score: ${data.total_karma || 0} | comment_score: ${data.comment_score || 0}`);
		if (data.profile) {
			console.log(`  account_age_days: ${formatNumber(((Date.now() / 1000) - (data.profile.created_utc || 0)) / 86400, 0)}`);
			console.log(`  link_karma: ${data.profile.link_karma || 0} | comment_karma: ${data.profile.comment_karma || 0}`);
		}
		if (subredditSummary.top) {
			console.log(`  top_subreddit: ${subredditSummary.top.name} ${formatPercent(subredditSummary.top.share)} (distinct ${subredditSummary.distinct})`);
		}
		if (domainSummary.top) {
			console.log(`  top_domain: ${domainSummary.top.name} ${formatPercent(domainSummary.top.share)} (distinct ${domainSummary.distinct})`);
		}
		if (urlSummary.top) {
			console.log(`  top_url: ${urlSummary.top.name} ${formatPercent(urlSummary.top.share)} (distinct ${urlSummary.distinct})`);
		}
		if (postTypeSummary.top) {
			console.log(`  top_post_type: ${postTypeSummary.top.name} ${formatPercent(postTypeSummary.top.share)} (distinct ${postTypeSummary.distinct})`);
		}
		if (commentSubSummary.top) {
			console.log(`  top_comment_sub: ${commentSubSummary.top.name} ${formatPercent(commentSubSummary.top.share)} (distinct ${commentSubSummary.distinct})`);
		}

		const existingLabel = labels[username];
		const labelPrompt = existingLabel ? `Label (s/o/u/skip/q) [current: ${existingLabel.label}]: ` : 'Label (s/o/u/skip/q): ';
		const labelInput = (await prompt(rl, labelPrompt)).toLowerCase();
		if (labelInput === 'q') break;
		if (labelInput === 'skip' || labelInput === 's' || labelInput === 'o' || labelInput === 'u') {
			if (labelInput === 'skip') {
				continue;
			}

			const labelMap = {
				s: 'likely_shill',
				o: 'likely_organic',
				u: 'unclear'
			};
			const labelValue = labelMap[labelInput];
			const confidenceInput = await prompt(rl, 'Confidence (0-1, optional): ');
			const notesInput = await prompt(rl, 'Notes (optional): ');

			labels[username] = {
				label: labelValue,
				confidence: confidenceInput ? Number.parseFloat(confidenceInput) : undefined,
				notes: notesInput || undefined
			};
			writeLabels(labelsPath, labels);
			console.log(`Saved label for ${username}`);
		}
	}

	rl.close();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
