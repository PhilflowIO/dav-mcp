# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT** create a public GitHub issue for security vulnerabilities
2. Email security concerns to: [security contact - to be added]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if available)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: 1-7 days
  - High: 7-30 days
  - Medium/Low: Best effort basis

### Security Best Practices

When using tsdav-mcp-server:

1. **Authentication**
   - Always set `BEARER_TOKEN` in production
   - Use strong, randomly generated tokens (min 32 characters)
   - Rotate tokens regularly

2. **Network Security**
   - Use HTTPS in production
   - Configure CORS with specific allowed origins
   - Deploy behind a reverse proxy (nginx, Caddy)

3. **Credentials**
   - Never commit `.env` files
   - Store CalDAV/CardDAV credentials securely
   - Use environment variables or secrets management

4. **Updates**
   - Keep dependencies updated
   - Monitor security advisories
   - Subscribe to release notifications

## Known Security Considerations

- Bearer token authentication is stateless (no session invalidation)
- Credentials stored in memory during runtime
- Rate limiting is IP-based (can be bypassed with proxy rotation)

For production deployments, consider:
- Implementing token rotation
- Using a secrets management system
- Adding additional authentication layers
- Monitoring and alerting
