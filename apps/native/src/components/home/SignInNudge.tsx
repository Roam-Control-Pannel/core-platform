/**
 * SignInNudge — the consistent sign-in prompt the auth-gated sections show instead of
 * gating the page. Same product rule as web: browsing Home needs no account, so a section
 * that can't fill without one explains itself and offers a way in.
 *
 * Web links to /account; native raises the just-in-time AuthSheet through useAuthPrompt,
 * so signing in happens without leaving Home — and the section it came from fills in as
 * soon as the session lands.
 */
import { View, Text, StyleSheet } from "react-native";
import { space } from "@roam/design/tokens";
import { Button } from "../../design";
import { useAuthPrompt } from "../AuthPrompt";
import { common } from "./common";

export function SignInNudge({ note }: { note: string }) {
  const prompt = useAuthPrompt();
  return (
    <View>
      <Text style={common.mutedNote}>{note}</Text>
      <View style={styles.cta}>
        <Button variant="pri" size="sm" onPress={() => prompt(note)}>
          Sign in
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cta: { marginTop: space[3], alignItems: "flex-start" },
});
