# Contributing to tsdav-mcp-server

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template (if available)
3. Include:
   - Node.js version
   - Operating system
   - Steps to reproduce
   - Expected vs actual behavior
   - Relevant logs

### Suggesting Features

1. Check existing feature requests
2. Describe the use case
3. Explain why it would be useful
4. Consider implementation complexity

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Make your changes**
4. **Test thoroughly**
5. **Commit with clear messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/)
6. **Push to your fork**: `git push origin feature/my-feature`
7. **Open a Pull Request**

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:
- `feat(tools): add bulk event creation support`
- `fix(auth): prevent timing attacks on token comparison`
- `docs(readme): update installation instructions`

## Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/tsdav-mcp-server.git
cd tsdav-mcp-server

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your CalDAV/CardDAV credentials
nano .env

# Run in development mode
npm run dev
```

## Code Standards

- Use ES modules (import/export)
- Follow existing code style
- Add JSDoc comments for functions
- Validate inputs with Zod
- Use structured logging (Pino)
- Handle errors properly
- Write tests for new features

## Testing

- Unit tests: Test individual functions
- Integration tests: Test tool operations
- E2E tests: Test with real CalDAV server

Run tests:
```bash
npm test          # Run all tests
npm run test:unit # Unit tests only
npm run test:e2e  # E2E tests only
```

## Documentation

- Update README.md for user-facing changes
- Update CLAUDE.md for architectural changes
- Add JSDoc comments for new functions
- Include examples for new features

## Code Review Process

1. All PRs require review
2. Address review feedback
3. Keep PRs focused and small
4. Update tests and docs
5. Ensure CI passes

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
