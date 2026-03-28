import { beforeEach } from 'vitest';

beforeEach(({ expect }) => {
  // The Jest team recommends this strategy of global configuration:
  // https://github.com/jestjs/jest/issues/5196#issuecomment-368432952
  // Using local expect ensures that concurrent tests don't interfere with each other
  // https://vitest.dev/guide/features.html#running-tests-concurrently
  expect.hasAssertions();
});
