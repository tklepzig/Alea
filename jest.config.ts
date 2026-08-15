import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  // Prefer .ts over .js so jest resolves to the source, not the compiled output.
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  // Strip ".js" extensions from imports so ts-jest can resolve the .ts source.
  // The .js extensions are required by the browser when serving compiled output,
  // but Jest works on the TS sources directly.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // Agent tooling checks out disposable copies of this repo under .claude/ (git
  // worktrees, so they hold a full second copy of every test file). Without this
  // a run picks them all up: one review left 15 behind and `npm test` reported
  // 5157 tests across 257 suites instead of 321 across 16, taking 6x as long.
  testPathIgnorePatterns: ["/node_modules/", "/.claude/"],
};

export default config;
