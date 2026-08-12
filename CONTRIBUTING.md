# Contributing to cheapkb

Thanks for helping improve CheapKB.

## Getting Started

1. Fork and clone the repository.
2. Create a focused branch.
3. Make and test your changes.
4. Submit a pull request.

## Development Setup

1. Install dependencies:

   ```bash
   npm ci --legacy-peer-deps
   npm --prefix web ci --legacy-peer-deps
   ```

2. Copy `.env.example` to `.env` and configure it.

3. Start the development environment:

   ```bash
   npx sst dev
   ```

## Pull Request Process

1. Update user-facing documentation when product behavior or usage changes.
2. Run the checks documented in the README.
3. Keep the pull request focused and use clear commit messages.

## Reporting Issues

- Use the GitHub issue tracker
- Include steps to reproduce the issue
- Include relevant errors without secrets or personal data

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
