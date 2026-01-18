# Reddit Top Posters Tracker

> **An open-source research project investigating content concentration on Reddit's front page.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Powered%20by-Cloudflare%20Workers-orange)](https://workers.cloudflare.com/)

## 🎯 Mission

This project aims to empirically investigate whether Reddit's front page (r/all) is dominated by a small number of high-volume accounts. By tracking posting patterns, we seek to:

1. **Quantify concentration** - What % of content comes from top posters?
2. **Identify patterns** - Are there signs of automated or coordinated posting?
3. **Empower users** - Provide block lists to improve content diversity
4. **Contribute to research** - Support academic study of platform authenticity

## 🔬 The Research Question

> *If you blocked the top 1,000 most prolific r/all posters, would your Reddit experience improve?*

Reddit allows blocking up to 1,000 accounts. We hypothesize that strategically blocking high-volume posters would surface more diverse, authentic content from regular users.

**Read the full research paper: [RESEARCH.md](./RESEARCH.md)**

## 📊 Live API

The tracker runs on Cloudflare Workers and exposes a public API:

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/top-posters` | Get ranked list of top posters |
| `GET /api/user?username=X` | Get stats for a specific user |
| `GET /api/stats` | System statistics |
| `GET /health` | Health check |

### Example Response

```json
{
  "date": "2026-01-08",
  "total": 610,
  "limit": 10,
  "users": [
    {
      "rank": 1,
      "username": "example_user",
      "post_count": 47,
      "total_karma": 284521,
      "first_seen": "2026-01-01",
      "daily_average": 6.7
    }
  ]
}
```

## 🚀 Deployment

### Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/reddit-tracker.git
cd reddit-tracker

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create KV namespaces
npx wrangler kv namespace create "REDDIT_USERS"
npx wrangler kv namespace create "REDDIT_POSTS"
npx wrangler kv namespace create "REDDIT_TOP_LISTS"
npx wrangler kv namespace create "REDDIT_CONFIG"

# Update wrangler.jsonc with the returned namespace IDs

# Deploy
npx wrangler deploy
```

### Configuration

Edit `wrangler.jsonc` to customize:

- `name` - Your worker name
- `triggers.crons` - Data collection schedule

Embeddings run as part of chunking. Manual runs require an admin token set as `ADMIN_TOKEN` (local: `.dev.vars`, deployed: `wrangler secret put ADMIN_TOKEN`) and passed via `Authorization: Bearer <token>` to `GET /api/trigger-chunking`.

## 📈 Data Collection

The worker collects data from Reddit's public API:

- **Sources**: r/all hot, new, and rising feeds
- **Frequency**: Configurable via cron triggers
- **Storage**: Cloudflare KV with 30-day retention
- **Metrics**: Post counts, karma, daily activity patterns

### Cloudflare Free Tier Considerations

Due to [Cloudflare's 50 subrequest limit](https://developers.cloudflare.com/workers/platform/limits/), data collection is batched:

- Each trigger processes ~10 posts
- Multiple triggers can be run per day to accumulate data
- The `/api/trigger` endpoint allows manual collection

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Ways to Help

- 📊 **Data Analysis** - Statistical analysis of collected data
- 📉 **Visualization** - Build dashboards and charts
- 📝 **Research** - Expand the research paper
- 💻 **Code** - Improve efficiency, add features
- 🔍 **Review** - Critique methodology

### Development

```bash
# Run locally
npx wrangler dev

# Type check
npx tsc --noEmit

# Pipeline health check (crawler + game + review flow)
npm run check:pipeline -- --base-url https://your-worker.workers.dev --dataset datasets/shill-dataset.jsonl --no-write-label
```

## 🧠 Data Science & Chunking

We implement robust segmentation for coordination research, moving beyond simple heuristics like account age or karma.

### Chunk Types

We segment activity into three distinct chunk types to capture different behavioral modes:

1.  **ACCOUNT_TEMPORAL_WINDOW**: Fixed 24h windows per account. Captures longitudinal shifts in an individual's output.
2.  **THREAD_SESSION**: Activity by one account in one thread, sessionized by 2h gaps. Captures engagement depth and topic-specific personas.
3.  **COPRESENCE_WINDOW**: Sliding 30m windows over threads tracking which accounts are active simultaneously. Captures coordination and "swarming" behaviors.

### Processing Pipeline

- **Incremental Processing**: Uses a watermark system to strictly process new items since the last run.
- **Embeddings**: Text content is embedded (vectorized) for semantic analysis.
    - Default: Deterministic generic embedding (stub) for testing/dev.
    - Production: Uses Cloudflare Workers AI embeddings when `ai` binding is configured in `wrangler.jsonc`.
- **Storage**: Raw items and chunks are stored in Cloudflare D1 (SQLite) for complex querying.

### Running the Pipeline / Tests

1.  **Create D1 Database**:
    ```bash
    npx wrangler d1 create reddit-tracker-db
    # Update wrangler.jsonc with the new database_id
    ```

2.  **Apply Schema**:
    ```bash
    npx wrangler d1 execute reddit-tracker-db --file=migrations/001_create_chunks_schema.sql
    ```

3.  **Run Logic Tests** (internal):
    Deploy the worker, then visit: `https://your-worker.workers.dev/api/test-chunking-logic`

4.  **Trigger Pipeline Manually**:
    `curl -H "Authorization: Bearer <token>" https://your-worker.workers.dev/api/trigger-chunking`

## 📜 Ethics & Privacy

- **Public Data Only**: We only access publicly available information
- **No PII**: Only usernames and public metadata are collected
- **No Manipulation**: This is observational research only
- **Transparency**: Full source code is open source

## 📚 Related Research

- [Dead Internet Theory](https://en.wikipedia.org/wiki/Dead_Internet_theory)
- [Computational Propaganda Research](https://comprop.oii.ox.ac.uk/)
- [Bot detection studies](https://botometer.osome.iu.edu/)

## 📄 License

MIT License - see [LICENSE](./LICENSE)

## 👤 Author

**u/tankyspanky** - Data analyst and researcher investigating platform authenticity.

---

*Built with ☁️ Cloudflare Workers*
