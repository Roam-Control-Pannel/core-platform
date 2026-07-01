/**
 * @roam/core — the framework-agnostic domain layer.
 *
 * One core, called by every shell through the api layer. No React, no Next, no
 * Expo, no transport assumptions. Business rules live here, once.
 *
 * Modules are also importable directly (e.g. `@roam/core/meetup`) for tree-shaking.
 */
export * as meetup from "./meetup/index.js";
export * as credits from "./credits/index.js";
export * as geo from "./geo/index.js";
export * as geocode from "./geocode/index.js";
export * as posts from "./posts/index.js";
export * as push from "./push/index.js";
export * as routes from "./routes/index.js";
export * as auth from "./auth/index.js";
export * as moderation from "./moderation/index.js";
export * as places from "./places/index.js";
export * as hours from "./hours/index.js";
export * as photos from "./photos/index.js";
export * as transit from "./transit/index.js";
export * as offers from "./offers/index.js";
