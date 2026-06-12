import { describe, it, expect } from "vitest";
import { parseAuthTokensFromUrl } from "./index.js";

describe("parseAuthTokensFromUrl", () => {
  it("extracts both tokens from the native triple-slash deep link", () => {
    // The exact shape iOS delivers: native://  + empty path  -> native:///#…
    const url = "native:///#access_token=abc&refresh_token=xyz";
    expect(parseAuthTokensFromUrl(url)).toEqual({
      accessToken: "abc",
      refreshToken: "xyz",
    });
  });

  it("also handles the two-slash form", () => {
    const url = "native://#access_token=abc&refresh_token=xyz";
    expect(parseAuthTokensFromUrl(url)).toEqual({
      accessToken: "abc",
      refreshToken: "xyz",
    });
  });

  it("ignores the extra fragment params Supabase includes", () => {
    const url =
      "native:///#access_token=abc&expires_in=3600&refresh_token=xyz&token_type=bearer&type=signup";
    expect(parseAuthTokensFromUrl(url)).toEqual({
      accessToken: "abc",
      refreshToken: "xyz",
    });
  });

  it("returns null when there is no fragment", () => {
    expect(parseAuthTokensFromUrl("native:///")).toBeNull();
  });

  it("returns null for the dev-client launch URL (query, not a token fragment)", () => {
    const url =
      "com.roamlocal.roam://expo-development-client/?url=http%3A%2F%2F192.168.1.221%3A8081";
    expect(parseAuthTokensFromUrl(url)).toBeNull();
  });

  it("returns null when only the access token is present", () => {
    expect(parseAuthTokensFromUrl("native:///#access_token=abc")).toBeNull();
  });

  it("returns null when only the refresh token is present", () => {
    expect(parseAuthTokensFromUrl("native:///#refresh_token=xyz")).toBeNull();
  });

  it("returns null when a token is present but empty", () => {
    expect(
      parseAuthTokensFromUrl("native:///#access_token=&refresh_token=xyz"),
    ).toBeNull();
  });
});
