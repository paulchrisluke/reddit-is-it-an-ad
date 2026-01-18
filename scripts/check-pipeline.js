#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const DEFAULT_BASE_URL = process.env.REDDIT_TRACKER_BASE_URL || 'http://localhost:8787';

function printUsage() {
	console.log([
		'Check that crawling, game, and training prerequisites are healthy.',
		'',
		'Usage:',
		'  node scripts/check-pipeline.js --base-url https://your-worker.workers.dev --username GallowBoob --dataset datasets/shill-dataset.jsonl',
		'',
		'Options:',
		'  --base-url <url>     Base URL for the worker API (default: http://localhost:8787)',
		'  --username <name>    Username to verify /api/user payload',
		'  --reviewer <id>      Reviewer id for /api/review/next (default: smoke-check)',
		'  --max-hours <n>      Max hours since last collection (default: 24)',
		'  --dataset <path>     Dataset JSONL to validate labels',
		'  --train              Run baseline training if labels allow',
		'  --model-out <path>   Output path for baseline model (default: models/baseline-model.json)',
		'  --no-write-label     Do not submit an "unclear" label for the fetched task',
		'  -h, --help           Show help',
	].join('\n'));
}

function parseArgs(argv) {
	const args = {
		baseUrl: DEFAULT_BASE_URL,
		username: null,
		reviewer: 'smoke-check',
		maxHours: 24,
		dataset: null,
		train: false,
		modelOut: 'models/baseline-model.json',
		writeLabel: true,
		help: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--base-url') {
			args.baseUrl = argv[++i];
			continue;
		}
		if (arg === '--username') {
			args.username = argv[++i];
			continue;
		}
		if (arg === '--reviewer') {
			args.reviewer = argv[++i];
			continue;
		}
		if (arg === '--max-hours') {
			args.maxHours = Number(argv[++i]);
			continue;
		}
		if (arg === '--dataset') {
			args.dataset = argv[++i];
			continue;
		}
		if (arg === '--train') {
			args.train = true;
			continue;
		}
		if (arg === '--model-out') {
			args.modelOut = argv[++i];
			continue;
		}
		if (arg === '--no-write-label') {
			args.writeLabel = false;
			continue;
		}
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			continue;
		}
	}

	return args;
}

async function fetchJson(url, options = {}) {
	const headers = { 'User-Agent': 'reddit-tracker-check/1.0', ...(options.headers || {}) };
	const response = await fetch(url, {
		...options,
		headers
	});

	if (!response.ok) {
		const error = new Error(`Request failed: ${response.status} ${response.statusText}`);
		error.status = response.status;
		error.body = await response.text();
		throw error;
	}

	return response.json();
}

async function fetchText(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'reddit-tracker-check/1.0' }
	});

	if (!response.ok) {
		const error = new Error(`Request failed: ${response.status} ${response.statusText}`);
		error.status = response.status;
		error.body = await response.text();
		throw error;
	}

	return response.text();
}

function formatHours(hours) {
	if (!Number.isFinite(hours)) return 'n/a';
	return `${hours.toFixed(2)}h`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}

	const baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	let ok = true;
	const warnings = [];

	console.log('Pipeline check');
	console.log(`Base URL: ${baseUrl}`);

	// Crawler health
	try {
		const stats = await fetchJson(`${baseUrl}/api/stats`);
		const last = stats.last_collection ? new Date(stats.last_collection) : null;
		if (!last || Number.isNaN(last.getTime())) {
			ok = false;
			console.log('Crawler: FAIL (missing last_collection)');
		} else {
			const ageHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
			const maxHours = Number.isFinite(args.maxHours) ? args.maxHours : 24;
			if (ageHours > maxHours) {
				ok = false;
				console.log(`Crawler: FAIL (last collection ${formatHours(ageHours)} ago)`);
			} else {
				console.log(`Crawler: OK (last collection ${formatHours(ageHours)} ago)`);
			}
		}
	} catch (error) {
		ok = false;
		console.log(`Crawler: FAIL (${error.message})`);
	}

	// Top posters coverage
	try {
		const top = await fetchJson(`${baseUrl}/api/top-posters?limit=5`);
		if (!Array.isArray(top.users) || top.users.length === 0) {
			ok = false;
			console.log('Top posters: FAIL (empty list)');
		} else {
			console.log(`Top posters: OK (${top.users.length} returned)`);
		}
	} catch (error) {
		ok = false;
		console.log(`Top posters: FAIL (${error.message})`);
	}

	// User signals (optional)
	if (args.username) {
		try {
			const userUrl = `${baseUrl}/api/user?username=${encodeURIComponent(args.username)}&include=signals,profile,profile_snapshots,url_reuse`;
			const user = await fetchJson(userUrl);
			if (!user || typeof user !== 'object') {
				ok = false;
				console.log('User signals: FAIL (invalid payload)');
			} else {
				console.log('User signals: OK');
			}
		} catch (error) {
			ok = false;
			console.log(`User signals: FAIL (${error.message})`);
		}
	}

	// Game page
	try {
		const html = await fetchText(`${baseUrl}/game`);
		if (!html.includes('Is It An Ad?')) {
			ok = false;
			console.log('Game UI: FAIL (missing header)');
		} else if (!html.includes('Skip (unclear)')) {
			ok = false;
			console.log('Game UI: FAIL (missing skip label)');
		} else {
			console.log('Game UI: OK');
		}
	} catch (error) {
		ok = false;
		console.log(`Game UI: FAIL (${error.message})`);
	}

	// Review flow
	try {
		const reviewUrl = `${baseUrl}/api/review/next?reviewer=${encodeURIComponent(args.reviewer)}&include=item&auto=true`;
		const review = await fetchJson(reviewUrl);
		if (review.status !== 'ok') {
			warnings.push('Review flow: empty queue');
		} else if (!review.task) {
			ok = false;
			console.log('Review flow: FAIL (missing task payload)');
		} else {
			console.log('Review flow: OK');
			if (args.writeLabel) {
				await fetchJson(`${baseUrl}/api/review/submit`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						task_id: review.task.task_id,
						label: 'unclear',
						reviewer_id: args.reviewer,
						confidence: 0.1,
						notes: 'smoke-check'
					})
				});
				console.log('Review flow: submitted unclear label');
			}
		}
	} catch (error) {
		ok = false;
		console.log(`Review flow: FAIL (${error.message})`);
	}

	// Dataset readiness
	let posCount = 0;
	let negCount = 0;
	if (args.dataset) {
		if (!fs.existsSync(args.dataset)) {
			ok = false;
			console.log(`Dataset: FAIL (missing ${args.dataset})`);
		} else {
			const lines = fs.readFileSync(args.dataset, 'utf8').split('\n').filter(Boolean);
			for (const line of lines) {
				const row = JSON.parse(line);
				if (row.label === 'likely_shill') posCount += 1;
				else if (row.label === 'likely_organic') negCount += 1;
			}
			console.log(`Dataset: OK (${lines.length} rows, pos=${posCount}, neg=${negCount})`);
			if (posCount === 0 || negCount === 0) {
				warnings.push('Training: missing positive or negative labels');
			} else if (args.train) {
				execFileSync('node', ['scripts/train-baseline.js', '--input', args.dataset, '--model-out', args.modelOut], { stdio: 'inherit' });
			}
		}
	}

	if (warnings.length > 0) {
		for (const warning of warnings) {
			console.log(`Warning: ${warning}`);
		}
	}

	if (!ok) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
