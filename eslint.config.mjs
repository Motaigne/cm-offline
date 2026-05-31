import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Serwist service worker bundle — minifié, pas notre code.
    "public/sw.js",
    "public/sw.js.map",
    "public/workbox-*.js",
  ]),
  {
    // Pattern courant ici : `const { foo: _foo, ...rest } = obj` pour drop
    // une prop dans un destructure. Le préfixe `_` signale l'intention de
    // ne pas utiliser la variable — ESLint doit le respecter.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
]);

export default eslintConfig;
