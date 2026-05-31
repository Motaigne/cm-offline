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
      // Downgrade en warning : l'app a beaucoup de patterns "sync prop→state"
      // et "init depuis localStorage en evitant le hydration mismatch" qui
      // necessitent legitimement un setState dans un effect. Les refactos
      // proposes par React (useSyncExternalStore, deriver pendant render avec
      // ref pour detecter le changement, etc.) sont disproportionnes vs le
      // cout reel (cascades de renders minimes). On garde le signal en warning
      // pour ne pas masquer les vrais cas problematiques.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
