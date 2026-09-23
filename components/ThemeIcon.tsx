import { THEME_OPTIONS, type ThemePreference } from "@/lib/theme";

// One chip per palette, tinted with the palette's own accent, so adding a theme
// needs no new artwork. "System" shows the light/dark halves instead.
const SWATCHES = new Map<string, string>(THEME_OPTIONS.map((option) => [option.id, option.swatch]));

export function ThemeIcon({ preference, size = 17 }: { preference: ThemePreference; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true };
  // A hairline keeps pale accents (Pine, Slate) readable on a pale panel.
  const ring = (
    <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="6" fill="none" stroke="currentColor" strokeOpacity="0.35" />
  );
  if (preference === "auto") {
    return (
      <svg {...common}>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="#f7f7f5" />
        <path d="M12 2h4a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6h-4Z" fill="#1c1c1e" />
        {ring}
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="2" width="20" height="20" rx="6" fill={SWATCHES.get(preference) ?? "currentColor"} />
      {ring}
    </svg>
  );
}
