# Contributing to Reddit Top Posters Tracker

Thank you for your interest in contributing! This is an open-source research project and we welcome all forms of contribution.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)

## Code of Conduct

This project adheres to a simple principle: be respectful and constructive. We're conducting academic research, not pursuing any agenda against individuals or the platform.

### Guidelines

- Focus on data and patterns, not individual users
- Maintain scientific objectivity
- Respect Reddit's Terms of Service
- Be kind to fellow contributors

## How Can I Contribute?

### 🐛 Reporting Bugs

Found a bug? Please open an issue with:

1. Description of the bug
2. Steps to reproduce
3. Expected vs actual behavior
4. Environment details (browser, OS, etc.)

### 💡 Suggesting Enhancements

Have an idea? Open an issue with:

1. Clear description of the enhancement
2. Use case / motivation
3. Potential implementation approach

### 📊 Data Analysis

The most valuable contributions are analyses of the collected data:

- Statistical analysis of posting patterns
- Visualization of trends
- Identification of interesting anomalies
- Academic paper contributions

### 💻 Code Contributions

We especially welcome:

- Performance optimizations
- New API endpoints
- Better error handling
- Documentation improvements
- Test coverage

## Development Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- Cloudflare account (for deployment)

### Local Development

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/reddit-tracker.git
cd reddit-tracker

# Install dependencies
npm install

# Run locally (uses local KV simulation)
npx wrangler dev

# The worker will be available at http://localhost:8787
```

### Testing

```bash
# Type checking
npx tsc --noEmit

# Manual testing
curl http://localhost:8787/api/stats
```

## Pull Request Process

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to your branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### PR Requirements

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated if needed
- [ ] No breaking changes (or clearly documented)
- [ ] Tests added for new functionality

## Style Guidelines

### TypeScript

- Use TypeScript for all code
- Define interfaces for data structures
- Avoid `any` when possible (use explicit types)
- Use meaningful variable names

### Commits

Use conventional commits:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

Example: `feat: add hourly posting pattern analysis`

### Documentation

- Update README for user-facing changes
- Update RESEARCH.md for methodology changes
- Add JSDoc comments for public functions

## 🔬 Research Contributions

If you'd like to contribute to the research paper:

1. Review the current [RESEARCH.md](./RESEARCH.md)
2. Propose additions via Issues
3. Submit PRs with new sections or data

### Citation

If you use this project in academic work, please cite:

```bibtex
@misc{reddit-top-posters-tracker,
  author = {tankyspanky et al.},
  title = {Reddit Top Posters Tracker},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/yourusername/reddit-tracker}
}
```

## Questions?

Open an issue or start a discussion. We're happy to help!

---

*Thank you for contributing to open research!*
