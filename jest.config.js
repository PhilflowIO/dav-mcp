export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  // The Claude plugin carries a copy of a released src/ and a package.json
  // named dav-mcp; jest must neither resolve modules there nor see a second
  // package of the same name.
  modulePathIgnorePatterns: ['<rootDir>/claude-plugin/'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server-stdio.js', // Skip server startup
    '!src/server-http.js', // Skip server startup
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
