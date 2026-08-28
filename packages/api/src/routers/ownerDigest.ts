/**
 * ownerDigest router — the one-click unsubscribe endpoint for the owner activity digest email.
 *
 * PUBLIC by design: the email link carries a signed HMAC token (ownerDigest/token) that IS the
 * authorisation, so no session is needed — an owner reading mail on any device can unsubscribe.
 * The token only grants "unsubscribe this owner id"; a bad/forged token is a no-op (ok:false).
 */
import { z } from "zod";
import { router, publicProcedure, escalateToService } from "../trpc.js";
import { verifyOwnerToken } from "../ownerDigest/token.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ownerDigestRouter = router({
  /** Set the owner's email opt-out from a signed unsubscribe token. Idempotent. */
  unsubscribe: publicProcedure
    .input(z.object({ token: z.string().min(1).max(600) }))
    .mutation(async ({ ctx, input }) => {
      const ownerId = verifyOwnerToken(input.token, ctx.env.ownerDigest.unsubscribeSecret);
      if (!ownerId) return { ok: false as const };
      const service = escalateToService(ctx.env) as unknown as { from: (t: string) => any };
      const { error } = await service
        .from("profiles")
        .update({ owner_digest_opt_out: true })
        .eq("id", ownerId);
      if (error) return { ok: false as const };
      return { ok: true as const };
    }),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
