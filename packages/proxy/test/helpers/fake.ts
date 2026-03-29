import { faker } from '@faker-js/faker';

/** Generate a unique file:// URI with the given extension. */
export const fakeUri = (ext = '.ts') =>
  `file:///${faker.string.alpha(10)}${ext}`;
