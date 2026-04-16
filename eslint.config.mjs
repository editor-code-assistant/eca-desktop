import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'eca-webview/**', 'src/renderer/*.js'],
    },
    ...tseslint.configs.strict,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            // Prevent any-creep — the main reason we added linting
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',

            // Practical relaxations
            '@typescript-eslint/no-require-imports': 'off', // esbuild bundling pattern
            '@typescript-eslint/no-non-null-assertion': 'off', // DOM getElementById!
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],

            // Style
            '@typescript-eslint/consistent-type-imports': 'warn',
        },
    },
);
