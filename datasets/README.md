# Datasets

Generated datasets may contain sensitive labels. Do not commit raw datasets tied to real usernames.

Recommended workflow:

- Generate datasets locally.
- Use `--anonymize` to replace usernames with stable hashes.
- Store any label maps outside the repo.

Example:

```bash
node scripts/build-dataset.js \
  --base-url https://reddit-tracker.paulchrisluke.workers.dev \
  --file tankyspanky-block-list.json \
  --seed \
  --anonymize \
  --output datasets/shill-dataset.jsonl
```
