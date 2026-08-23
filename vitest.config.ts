import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

export default defineVitestConfig({
  layer: 'unit',
  include: ['src/**/*.test.ts'],
});
