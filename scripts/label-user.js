#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function printUsage() {
	console.log([
		'Label a Reddit account for the shill detection dataset.',
		'',
		'Usage:',
		'  node scripts/label-user.js --file labels.json --user GallowBoob --label likely_shill --confidence 0.8 --notes "High-volume image spam"',
		'',
		'Options:',
		'  --file <path>        Labels JSON file (default: labels.json)',
		'  --user <name>        Reddit username (required)',
		'  --label <value>      Label (likely_shill|likely_organic|unclear)',
		'  --confidence <n>     Confidence 0-1 (optional)',
		'  --notes <text>       Notes/evidence (optional)',
		'  --delete             Remove the user label',
		'  -h, --help           Show this help',
	].join('\n'));
}

function parseArgs(argv) {
	const args = {
		file: 'labels.json',
		user: null,
		label: null,
		confidence: null,
		notes: null,
		delete: false,
		help: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--file' || arg === '-f') {
			args.file = argv[++i];
			continue;
		}
		if (arg === '--user' || arg === '-u') {
			args.user = argv[++i];
			continue;
		}
		if (arg === '--label' || arg === '-l') {
			args.label = argv[++i];
			continue;
		}
		if (arg === '--confidence') {
			args.confidence = Number.parseFloat(argv[++i]);
			continue;
		}
		if (arg === '--notes') {
			args.notes = argv[++i];
			continue;
		}
		if (arg === '--delete') {
			args.delete = true;
			continue;
		}
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			continue;
		}
	}

	return args;
}

function loadLabels(filePath) {
	if (!fs.existsSync(filePath)) return {};
	const raw = fs.readFileSync(filePath, 'utf8');
	if (!raw.trim()) return {};
	return JSON.parse(raw);
}

function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printUsage();
		return;
	}

	if (!args.user) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const username = String(args.user).trim();
	if (!username) {
		console.error('Username is required.');
		process.exitCode = 1;
		return;
	}

	const filePath = args.file || 'labels.json';
	const labels = loadLabels(filePath);

	if (args.delete) {
		delete labels[username];
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(labels, null, 2));
		console.log(`Removed label for ${username} in ${filePath}`);
		return;
	}

	if (!args.label) {
		console.error('Label is required unless --delete is set.');
		process.exitCode = 1;
		return;
	}

	const entry = {
		label: args.label
	};
	if (Number.isFinite(args.confidence)) entry.confidence = args.confidence;
	if (args.notes) entry.notes = args.notes;

	labels[username] = entry;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(labels, null, 2));
	console.log(`Saved label for ${username} in ${filePath}`);
}

main();
