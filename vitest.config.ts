import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/main/**/*.ts'],
            exclude: ['src/main/main.ts'],
            thresholds: {
                // Non-blocking initial thresholds; raise over time as coverage grows.
                lines: 50,
                branches: 40,
            },
        },
    },
});
