// Metro config for @roam/native in the pnpm monorepo.
//
// The default Expo Metro config only watches this app's folder and won't reach
// sibling workspace packages. We teach it about the monorepo so it can resolve
// and transpile @roam/core's raw .ts source directly — the same shared-core
// consumption the web app does, the RN analogue of the Turbopack seam.
//
//   1. watchFolders → the workspace root, so Metro sees packages/* changes.
//   2. nodeModulesPaths → both this app's hoisted node_modules and the root
//      store, so pnpm-linked workspace deps resolve.
//   3. disableHierarchicalLookup stays off — we WANT Metro walking up to root.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
