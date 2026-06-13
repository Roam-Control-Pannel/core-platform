/**
 * AuthSheet — native just-in-time auth, the RN analogue of web's AuthPanel.
 *
 * Presented as a state-controlled Modal (not a router route) so the gated action that
 * opened it can RESUME on success: the trigger (e.g. a FollowButton) owns the intent,
 * opens the sheet, and runs the held action in onAuthed. Same contract as web's
 * AuthPanel — two modes, email confirmation handling — rebuilt with RN inputs.
 *
 *   SIGN IN  (existing user): success -> a live session exists immediately -> onAuthed()
 *            fires and the held action proceeds in the same sitting.
 *   SIGN UP  (new user): with email confirmation ON (project default), signUp returns NO
 *            session — the user must confirm via the emailed link first. So sign-up does
 *            NOT call onAuthed; it shows a "check your email" state. The confirmation
 *            deep-links back via the native:// scheme (emailRedirectTo).
 *
 * Talks to Supabase through the same getSupabaseNative the TrpcProvider reads, so a
 * successful sign-in flows into the existing token -> RLS path with no extra wiring
 * (onAuthStateChange in the provider updates the session, rebuilding the tRPC client).
 */
import { useState } from "react";
import { color } from "@roam/design/tokens";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { getSupabaseNative } from "../lib/supabase";

type Mode = "signin" | "signup";

export interface AuthSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Fires when a LIVE session now exists (sign-in success). Sign-up does NOT fire this
   *  — it has no session until email confirmation. The trigger resumes its action here. */
  onAuthed: () => void;
  /** Optional context line shown above the form (e.g. "Sign in to follow this venue"). */
  intro?: string;
}

/** Native deep-link the sign-up confirmation returns to (app.json scheme = "native"). */
const EMAIL_REDIRECT_TO = "native://";

export function AuthSheet({ visible, onClose, onAuthed, intro }: AuthSheetProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  function reset() {
    setError(null);
    setConfirmSent(false);
    setBusy(false);
  }

  async function submit() {
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and a password.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }

    setBusy(true);
    const supabase = getSupabaseNative();
    try {
      if (mode === "signin") {
        const { data, error: e } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (e) {
          setError(friendlyAuthError(e.message));
          return;
        }
        if (data.session) {
          onAuthed();
          return;
        }
        setError("Couldn't sign you in. Please try again.");
      } else {
        const { data, error: e } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: { emailRedirectTo: EMAIL_REDIRECT_TO },
        });
        if (e) {
          setError(friendlyAuthError(e.message));
          return;
        }
        // Email confirmation ON: session is null; user must confirm via email.
        if (data.session) {
          onAuthed();
          return;
        }
        setConfirmSent(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {confirmSent ? (
            <View style={styles.body}>
              <Text style={styles.title}>Check your email</Text>
              <Text style={styles.copy}>
                We&apos;ve sent a confirmation link to {email.trim()}. Open it to confirm
                your account, then come back and sign in.
              </Text>
              <Pressable style={styles.primaryBtn} onPress={onClose}>
                <Text style={styles.primaryBtnText}>Done</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.body}>
              {intro ? <Text style={styles.intro}>{intro}</Text> : null}

              <View style={styles.tabs}>
                <ModeTab
                  label="Sign in"
                  active={mode === "signin"}
                  onPress={() => {
                    setMode("signin");
                    setError(null);
                  }}
                />
                <ModeTab
                  label="Create account"
                  active={mode === "signup"}
                  onPress={() => {
                    setMode("signup");
                    setError(null);
                  }}
                />
              </View>

              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                value={email}
                onChangeText={setEmail}
                editable={!busy}
              />
              <TextInput
                style={styles.input}
                placeholder={mode === "signup" ? "At least 8 characters" : "Password"}
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                textContentType={mode === "signin" ? "password" : "newPassword"}
                value={password}
                onChangeText={setPassword}
                editable={!busy}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable
                style={[styles.primaryBtn, busy && styles.primaryBtnDisabled]}
                onPress={() => void submit()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={color.card} />
                ) : (
                  <Text style={styles.primaryBtnText}>
                    {mode === "signin" ? "Sign in" : "Create account"}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={() => {
                  reset();
                  onClose();
                }}
                disabled={busy}
              >
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ModeTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tab}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
      <View style={[styles.tabUnderline, active && styles.tabUnderlineActive]} />
    </Pressable>
  );
}

/** Map Supabase auth error strings to friendlier copy without leaking internals. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "That email or password doesn't match.";
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "That email already has an account — try signing in instead.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  return "Couldn't complete that. Please check your details and try again.";
}


const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(33,29,26,0.38)" },
  sheet: {
    backgroundColor: color.card,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 36,
  },
  handle: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 999,
    backgroundColor: color.line2,
    marginBottom: 12,
  },
  body: { gap: 12 },
  intro: { fontSize: 15, lineHeight: 21, color: color.ink2 },
  title: { fontSize: 22, fontWeight: "700", color: color.inkHi },
  copy: { fontSize: 15, lineHeight: 21, color: color.ink2 },
  tabs: { flexDirection: "row", gap: 18, marginBottom: 4 },
  tab: { paddingVertical: 4 },
  tabText: { fontSize: 14, fontWeight: "600", color: color.muted },
  tabTextActive: { color: color.inkHi },
  tabUnderline: { height: 2, marginTop: 4, backgroundColor: "transparent" },
  tabUnderlineActive: { backgroundColor: color.crimson },
  input: {
    borderWidth: 1,
    borderColor: color.line2,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: color.ink,
  },
  error: { color: color.crimson700, fontSize: 13 },
  primaryBtn: {
    backgroundColor: color.crimson,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: color.card, fontSize: 15, fontWeight: "600" },
  cancel: { textAlign: "center", color: color.muted, fontSize: 14, paddingVertical: 10 },
});
