export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js', // Skip server startup
    '!src/server-stdio.js', // Skip server startup
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
