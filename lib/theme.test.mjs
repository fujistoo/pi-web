import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { DARK_THEMES, THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";

test("first paint restores every palette and falls back to the system for invalid or blocked storage", () => {
  for (const systemDark of [false, true]) {
    for (const stored of [...THEME_OPTIONS.map(({ id }) => id), null, "", "unknown", new Error("Blocked")]) {
      const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      runInNewContext(THEME_INIT_SCRIPT, {
        localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: root },
      });
      const expected = isThemePreference(stored) && stored !== "auto" ? stored : systemDark ? "dark" : "light";
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
    }
  }
});

// Every palette is defined in CSS, and its body text sits in the readable but
// not harsh band. Pure #000/#fff (21:1) is where bright text starts to bleed
// into the surround (halation) and reads worse than a mid-contrast palette.
function luminance(hex) {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
  const channels = digits.match(/../g).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const SURFACES = ["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg"];
const FOREGROUNDS = ["text", "text-muted", "text-dim", "accent"];

test("ships every palette with eye-safe body-text contrast", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  for (const { id } of THEME_OPTIONS) {
    if (id === "auto") {
      assert.doesNotMatch(css, /\[data-theme="auto"\]/, "auto resolves to a concrete palette");
      continue;
    }
    const block = css.match(new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([^}]*)\\}`));
    assert.ok(block, `${id} has a palette block`);
    const token = (name) => (block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`)) ?? [])[1];
    const light = token("bg");
    const text = token("text");
    assert.ok(light && text, `${id} defines --bg and --text`);

    const ratio = contrast(light, text);
    assert.ok(ratio >= 4.5, `${id} body text is at least WCAG AA (got ${ratio.toFixed(1)}:1)`);
    assert.ok(ratio <= 18, `${id} body text avoids max-contrast halation (got ${ratio.toFixed(1)}:1)`);

    // The same matrix e2e/themes.mjs walks in a browser, asserted here so a
    // hand-edited hex fails `npm test` instead of a Playwright run.
    for (const foreground of FOREGROUNDS) {
      for (const surface of SURFACES) {
        const value = contrast(token(foreground), token(surface));
        assert.ok(value >= 4.5, `${id}: ${foreground} on ${surface} must meet WCAG AA (got ${value.toFixed(2)}:1)`);
      }
    }
    for (const surface of ["accent", "accent-hover"]) {
      const value = contrast(token("accent-contrast"), token(surface));
      assert.ok(value >= 4.5, `${id}: accent-contrast on ${surface} must meet WCAG AA (got ${value.toFixed(2)}:1)`);
    }
  }
});

// The chip a palette shows in settings is its own accent, and the pre-paint
// script's dark list has to agree with what the stylesheet says.
test("keeps every swatch and dark flag in step with the stylesheet", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const dark = [];
  for (const { id, swatch } of THEME_OPTIONS) {
    if (id === "auto") {
      assert.equal(swatch, "", "auto has no accent of its own");
      continue;
    }
    const block = css.match(new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([^}]*)\\}`));
    assert.ok(block, `${id} has a palette block`);
    assert.equal(
      (block[1].match(/--accent:\s*(#[0-9a-f]{3,8})/) ?? [])[1],
      swatch,
      `${id} swatch is its --accent`,
    );
    if (/color-scheme:\s*dark/.test(block[1])) dark.push(id);
  }
  assert.deepEqual([...DARK_THEMES].sort(), dark.sort(), "dark themes match the stylesheet");
});

// Every palette is picked by a translated name, so a missing label would render
// the raw key in the settings grid.
test("labels every palette in every locale", async () => {
  const locales = ["en", "zh-CN", "zh-TW"];
  const sources = await Promise.all(
    locales.map((locale) => readFile(new URL(`./i18n/messages/${locale}.ts`, import.meta.url), "utf8")),
  );
  const labels = new Set(THEME_OPTIONS.map(({ label }) => label));
  assert.equal(labels.size, THEME_OPTIONS.length, "each palette has its own label key");
  for (const { label } of THEME_OPTIONS) {
    for (const [index, source] of sources.entries()) {
      assert.ok(source.includes(`"${label}": "`), `${label} is translated in ${locales[index]}`);
    }
  }
});
