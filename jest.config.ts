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
};

export default config;
