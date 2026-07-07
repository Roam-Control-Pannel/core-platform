/**
 * @roam/api public surface.
 *
 * Shells import { type AppRouter } for end-to-end types and point a tRPC client at the
 * deployed service URL. The standalone service (server.ts / a fetch adapter) imports
 * appRouter + makeContextFactory to actually serve requests. Keeping these in one
 * barrel means a shell never accidentally pulls server-only code into its bundle —
 * it imports only the type.
 */
export { appRouter, type AppRouter } from "./routers/index.js";
// Re-exported so client packages can NAME the inferred router type (TS2883 portability) —
// profiles.placePrefs surfaces StoredPlace; payments.accountStatus surfaces PayoutStatus.
export { type StoredPlace } from "./routers/profiles.js";
export { type PayoutStatus } from "./routers/payments.js";
export { type MarketProduct } from "./routers/market.js";
export { type MarketListing } from "./routers/listings.js";
export {
  makeContextFactory,
  type Context,
  type ApiEnv,
  type HeaderBag,
  type CreateContext,
} from "./context.js";
export { router, publicProcedure, protectedProcedure, internalProcedure } from "./trpc.js";
