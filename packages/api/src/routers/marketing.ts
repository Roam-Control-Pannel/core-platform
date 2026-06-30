/**
 * marketing — server-side Brevo contact sync.
 *
 * The new-user → Brevo-list hop. A Supabase Database Webhook on `profiles` INSERT calls the
 * web's /api/brevo/contact-created route, which (holding the x-internal-call secret) invokes
 * `syncNewUser` here — same trusted-hop posture as places.ingestArea. We look up the user's
 * email with the service client (the profile id IS the auth user id) and upsert them to the
 * new-users list. Best-effort: a Brevo failure logs and returns ok:false, never throws, so a
 * signup is never blocked by the marketing side effect.
 *
 * The OTHER sync moment — an approved business owner joining the businesses list — lives in
 * venues.approveClaim, because that path already runs server-side with the service client.
 */
import { z } from "zod";
import { router, internalProcedure } from "../trpc.js";
import { upsertBrevoContact } from "../brevo/client.js";

export const marketingRouter = router({
  /**
   * Internal: add a newly-created user to the Brevo new-users list. Input is the profile id
   * (= auth user id). Returns a small status object; callers treat any outcome as non-fatal.
   */
  syncNewUser: internalProcedure
    .input(z.object({ profileId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.service.auth.admin.getUserById(input.profileId);
      const email = data?.user?.email;
      if (error || !email) {
        return { ok: false as const, reason: "no_email" as const };
      }
      const ok = await upsertBrevoContact(ctx.env.brevo.apiKey, email, ctx.env.brevo.newUserListId);
      return { ok };
    }),
});
