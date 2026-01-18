#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function printUsage() {
	console.log([
		'Train a baseline logistic regression model from a JSONL dataset.',
		'',
		'Usage:',
		'  node scripts/train-baseline.js --input datasets/shill-dataset.jsonl --model-out models/baseline-model.json',
		'',
		'Options:',
		'  --input <path>        Dataset JSONL path (default: datasets/shill-dataset.jsonl)',
		'  --model-out <path>    Output model JSON (default: models/baseline-model.json)',
		'  --label-pos <label>   Positive label (default: likely_shill)',
		'  --label-neg <label>   Negative label (default: likely_organic)',
		'  --test-split <ratio>  Holdout split fraction (default: 0.2)',
		'  --epochs <n>          Training epochs (default: 200)',
		'  --lr <n>              Learning rate (default: 0.1)',
		'  --lambda <n>          L2 regularization (default: 0.01)',
		'  --seed <n>            RNG seed (default: 42)',
		'  -h, --help            Show this help',
	].join('\n'));
}

function parseArgs(argv) {
	const args = {
		input: 'datasets/shill-dataset.jsonl',
		modelOut: 'models/baseline-model.json',
		labelPos: 'likely_shill',
		labelNeg: 'likely_organic',
		testSplit: 0.2,
		epochs: 200,
		lr: 0.1,
		lambda: 0.01,
		seed: 42,
		help: false
	};

	function requireValue(flag) {
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) {
			throw new Error(`Missing value for ${flag}`);
		}
		return next;
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--input') {
			args.input = requireValue(arg);
			continue;
		}
		if (arg === '--model-out') {
			args.modelOut = requireValue(arg);
			continue;
		}
		if (arg === '--label-pos') {
			args.labelPos = requireValue(arg);
			continue;
		}
		if (arg === '--label-neg') {
			args.labelNeg = requireValue(arg);
			continue;
		}
		if (arg === '--test-split') {
			args.testSplit = Number(requireValue(arg));
			continue;
		}
		if (arg === '--epochs') {
			args.epochs = Number(requireValue(arg));
			continue;
		}
		if (arg === '--lr') {
			args.lr = Number(requireValue(arg));
			continue;
		}
		if (arg === '--lambda') {
			args.lambda = Number(requireValue(arg));
			continue;
		}
		if (arg === '--seed') {
			args.seed = Number(requireValue(arg));
			continue;
		}
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			continue;
		}
	}

	return args;
}

function mulberry32(seed) {
	let t = seed >>> 0;
	return function () {
		t += 0x6D2B79F5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(array, rng) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

function sigmoid(x) {
	if (x >= 0) {
		const z = Math.exp(-x);
		return 1 / (1 + z);
	}
	const z = Math.exp(x);
	return z / (1 + z);
}

function safeNumber(value) {
	return Number.isFinite(value) ? value : 0;
}

function buildFeatureKeys(samples) {
	const keys = new Set();
	for (const sample of samples) {
		const features = sample.features || {};
		for (const [key, value] of Object.entries(features)) {
			if (Number.isFinite(value)) keys.add(key);
		}
	}
	return Array.from(keys).sort();
}

function vectorize(sample, featureKeys, means, stds) {
	const features = sample.features || {};
	const vector = new Array(featureKeys.length);
	for (let i = 0; i < featureKeys.length; i++) {
		const key = featureKeys[i];
		const value = safeNumber(features[key]);
		const mean = means[i];
		const std = stds[i] || 1;
		vector[i] = (value - mean) / std;
	}
	return vector;
}

function computeNormalization(samples, featureKeys) {
	const sums = new Array(featureKeys.length).fill(0);
	const sumsSq = new Array(featureKeys.length).fill(0);

	for (const sample of samples) {
		const features = sample.features || {};
		for (let i = 0; i < featureKeys.length; i++) {
			const value = safeNumber(features[featureKeys[i]]);
			sums[i] += value;
			sumsSq[i] += value * value;
		}
	}

	const count = samples.length || 1;
	const means = sums.map((sum) => sum / count);
	const stds = sumsSq.map((sumSq, i) => {
		const mean = means[i];
		const variance = Math.max(0, (sumSq / count) - (mean * mean));
		return Math.sqrt(variance) || 1;
	});

	return { means, stds };
}

function dot(weights, vector) {
	let sum = 0;
	for (let i = 0; i < weights.length; i++) {
		sum += weights[i] * vector[i];
	}
	return sum;
}

function evaluate(samples, weights, bias, featureKeys, means, stds) {
	if (samples.length === 0) {
		return {
			total: 0,
			loss: 0,
			accuracy: 0,
			precision: 0,
			recall: 0,
			f1: 0,
			confusion: { tp: 0, fp: 0, tn: 0, fn: 0 }
		};
	}

	let tp = 0;
	let fp = 0;
	let tn = 0;
	let fn = 0;
	let loss = 0;
	const eps = 1e-9;

	for (const sample of samples) {
		const vector = vectorize(sample, featureKeys, means, stds);
		const score = sigmoid(bias + dot(weights, vector));
		const pred = score >= 0.5 ? 1 : 0;
		const y = sample.label;

		if (pred === 1 && y === 1) tp += 1;
		else if (pred === 1 && y === 0) fp += 1;
		else if (pred === 0 && y === 0) tn += 1;
		else fn += 1;

		loss += -(y * Math.log(score + eps) + (1 - y) * Math.log(1 - score + eps));
	}

	const total = samples.length || 1;
	const accuracy = (tp + tn) / total;
	const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
	const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	return {
		total,
		loss: loss / total,
		accuracy,
		precision,
		recall,
		f1,
		confusion: { tp, fp, tn, fn }
	};
}

function formatMetric(value) {
	if (!Number.isFinite(value)) return 'n/a';
	return value.toFixed(3);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}

	if (!fs.existsSync(args.input)) {
		console.error(`Input not found: ${args.input}`);
		process.exitCode = 1;
		return;
	}

	const raw = fs.readFileSync(args.input, 'utf8').split('\n').filter(Boolean);
	const labeled = [];

	for (let i = 0; i < raw.length; i++) {
		const line = raw[i];
		let row;
		try {
			row = JSON.parse(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const snippet = line.length > 120 ? `${line.slice(0, 117)}...` : line;
			console.warn(`Skipping line ${i + 1}: ${message} (${snippet})`);
			continue;
		}
		const label = row.label;
		if (label === args.labelPos) {
			labeled.push({ features: row.features || {}, label: 1 });
		} else if (label === args.labelNeg) {
			labeled.push({ features: row.features || {}, label: 0 });
		}
	}

	const posCount = labeled.filter((row) => row.label === 1).length;
	const negCount = labeled.length - posCount;

	if (posCount === 0 || negCount === 0) {
		console.error(`Need both positive (${args.labelPos}) and negative (${args.labelNeg}) labels. Found ${posCount} positive, ${negCount} negative.`);
		process.exitCode = 1;
		return;
	}

	const featureKeys = buildFeatureKeys(labeled);
	if (featureKeys.length === 0) {
		console.error('No numeric features found in dataset.');
		process.exitCode = 1;
		return;
	}

	const rng = mulberry32(Number.isFinite(args.seed) ? args.seed : 42);
	const testSplit = Number.isFinite(args.testSplit) ? Math.min(Math.max(args.testSplit, 0.05), 0.5) : 0.2;
	const byLabel = new Map();
	for (let i = 0; i < labeled.length; i++) {
		const label = labeled[i].label;
		if (!byLabel.has(label)) byLabel.set(label, []);
		byLabel.get(label).push(i);
	}

	const testIndices = [];
	const trainIndices = [];
	for (const indices of byLabel.values()) {
		shuffle(indices, rng);
		const classCount = indices.length;
		let classTestCount = Math.floor(classCount * testSplit);
		if (classCount > 1 && classTestCount === 0) classTestCount = 1;
		if (classCount > 1 && classTestCount >= classCount) classTestCount = classCount - 1;
		testIndices.push(...indices.slice(0, classTestCount));
		trainIndices.push(...indices.slice(classTestCount));
	}

	shuffle(testIndices, rng);
	shuffle(trainIndices, rng);

	const testSet = testIndices.map((idx) => labeled[idx]);
	const trainSet = trainIndices.map((idx) => labeled[idx]);

	if (trainSet.length === 0) {
		console.error('Dataset too small for train/test split. Need at least 2 samples.');
		process.exitCode = 1;
		return;
	}

	const { means, stds } = computeNormalization(trainSet, featureKeys);
	const weights = new Array(featureKeys.length).fill(0);
	let bias = 0;
	const lr = Number.isFinite(args.lr) ? args.lr : 0.1;
	const lambda = Number.isFinite(args.lambda) ? args.lambda : 0.01;
	const epochs = Number.isFinite(args.epochs) ? Math.max(1, Math.floor(args.epochs)) : 200;
	const eps = 1e-9;

	for (let epoch = 0; epoch < epochs; epoch++) {
		let gradBias = 0;
		const grads = new Array(featureKeys.length).fill(0);
		let loss = 0;

		for (const sample of trainSet) {
			const vector = vectorize(sample, featureKeys, means, stds);
			const score = sigmoid(bias + dot(weights, vector));
			const error = score - sample.label;
			gradBias += error;
			for (let i = 0; i < grads.length; i++) {
				grads[i] += error * vector[i];
			}
			loss += -(sample.label * Math.log(score + eps) + (1 - sample.label) * Math.log(1 - score + eps));
		}

		const scale = 1 / trainSet.length;
		bias -= lr * gradBias * scale;
		for (let i = 0; i < grads.length; i++) {
			const grad = (grads[i] * scale) + (lambda * weights[i]);
			weights[i] -= lr * grad;
		}

		if (epoch === 0 || epoch === epochs - 1) {
			console.log(`Epoch ${epoch + 1}/${epochs} loss=${(loss / trainSet.length).toFixed(4)}`);
		}
	}

	const trainMetrics = evaluate(trainSet, weights, bias, featureKeys, means, stds);
	const testMetrics = evaluate(testSet, weights, bias, featureKeys, means, stds);

	console.log('');
	console.log(`Samples: ${labeled.length} (pos=${posCount}, neg=${negCount})`);
	console.log(`Train: ${trainSet.length} Test: ${testSet.length}`);
	console.log(`Train accuracy=${formatMetric(trainMetrics.accuracy)} f1=${formatMetric(trainMetrics.f1)} loss=${formatMetric(trainMetrics.loss)}`);
	console.log(`Test  accuracy=${formatMetric(testMetrics.accuracy)} f1=${formatMetric(testMetrics.f1)} loss=${formatMetric(testMetrics.loss)}`);

	const ranked = featureKeys
		.map((key, idx) => ({ key, weight: weights[idx] }))
		.sort((a, b) => b.weight - a.weight);
	const topPos = ranked.slice(0, 8);
	const topNeg = ranked.slice(-8).reverse();

	console.log('\nTop positive weights:');
	for (const item of topPos) {
		console.log(`  ${item.key}: ${item.weight.toFixed(4)}`);
	}
	console.log('Top negative weights:');
	for (const item of topNeg) {
		console.log(`  ${item.key}: ${item.weight.toFixed(4)}`);
	}

	const model = {
		trained_at: new Date().toISOString(),
		labels: { positive: args.labelPos, negative: args.labelNeg },
		feature_keys: featureKeys,
		means,
		stds,
		weights,
		bias,
		metrics: { train: trainMetrics, test: testMetrics },
		params: {
			epochs,
			learning_rate: lr,
			l2_lambda: lambda,
			test_split: testSplit,
			seed: args.seed
		}
	};

	fs.mkdirSync(path.dirname(args.modelOut), { recursive: true });
	fs.writeFileSync(args.modelOut, JSON.stringify(model, null, 2));
	console.log(`\nSaved model to ${args.modelOut}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
