export default {
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/tsdav/'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tsdav/'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
};
