/**
 * AuthPromptProvider — one app-wide host for the just-in-time AuthSheet.
 *
 * Native's auth model is "browse freely, sign in at the moment it matters" (see
 * TrpcProvider: a null session is valid). That means ANY control, at any depth, may need
 * to raise the sheet — the followed-venues nudge, the composer, a follow button. Threading
 * `visible` + a held intent down through every section would be noise, so the sheet lives
 * here and children ask for it through `useAuthPrompt()`.
 *
 * The RESUME contract from the existing screens is preserved: the caller passes the action
 * it wanted to take, we hold it while the sheet is up, and run it once a live session
 * exists. Sign-UP intentionally doesn't resume (no session until the emailed link is
 * confirmed) — that's AuthSheet's own contract, and it simply never calls onAuthed.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AuthSheet } from "./AuthSheet";

/**
 * Raise the sign-in sheet.
 * @param intro Context line explaining why signing in helps, shown above the form.
 * @param resume Optional action to run once a live session exists.
 */
export type AuthPrompt = (intro: string, resume?: () => void) => void;

const AuthPromptContext = createContext<AuthPrompt | null>(null);

export function AuthPromptProvider({ children }: { children: ReactNode }) {
  const [intro, setIntro] = useState<string | null>(null);
  // A ref, not state: the held action is a side effect to run later, and rewriting it
  // must never trigger a render of the whole tree under the provider.
  const resumeRef = useRef<(() => void) | null>(null);

  const prompt = useCallback<AuthPrompt>((nextIntro, resume) => {
    resumeRef.current = resume ?? null;
    setIntro(nextIntro);
  }, []);

  const close = useCallback(() => {
    resumeRef.current = null;
    setIntro(null);
  }, []);

  const onAuthed = useCallback(() => {
    const resume = resumeRef.current;
    resumeRef.current = null;
    setIntro(null);
    // The session lands via onAuthStateChange in TrpcProvider; the held action reads the
    // live tRPC client when it runs, so there's no stale-client race here.
    resume?.();
  }, []);

  const value = useMemo(() => prompt, [prompt]);

  return (
    <AuthPromptContext.Provider value={value}>
      {children}
      <AuthSheet
        visible={intro !== null}
        {...(intro ? { intro } : {})}
        onClose={close}
        onAuthed={onAuthed}
      />
    </AuthPromptContext.Provider>
  );
}

/** Raise the just-in-time sign-in sheet. Throws outside the provider. */
export function useAuthPrompt(): AuthPrompt {
  const prompt = useContext(AuthPromptContext);
  if (!prompt) throw new Error("useAuthPrompt must be used within <AuthPromptProvider>.");
  return prompt;
}
