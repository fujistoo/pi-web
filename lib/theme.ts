export const THEME_OPTIONS = [
  { id: "light", label: "settings.themeLight", swatch: "#245bce" },
  { id: "dark", label: "settings.themeDark", swatch: "#a4c2f4" },
  { id: "mist", label: "settings.themeMist", swatch: "#1e6559" },
  { id: "rose", label: "settings.themeRose", swatch: "#914360" },
  { id: "pine", label: "settings.themePine", swatch: "#acccb7" },
  { id: "sepia", label: "settings.themeSepia", swatch: "#78470e" },
  { id: "ember", label: "settings.themeEmber", swatch: "#e2a878" },
  { id: "slate", label: "settings.themeSlate", swatch: "#b8cfeb" },
  { id: "absolutely-light", label: "settings.themeAbsolutely", swatch: "#9a4e31" },
  { id: "ayu-dark", label: "settings.themeAyuDark", swatch: "#ffb454" },
  { id: "ayu-light", label: "settings.themeAyuLight", swatch: "#8f570d" },
  { id: "catppuccin-latte", label: "settings.themeCatppuccinLatte", swatch: "#0a50dc" },
  { id: "catppuccin-mocha", label: "settings.themeCatppuccinMocha", swatch: "#89b4fa" },
  { id: "codex-dark", label: "settings.themeCodex", swatch: "#47a5ff" },
  { id: "dracula", label: "settings.themeDracula", swatch: "#c6a2f9" },
  { id: "everforest-dark", label: "settings.themeEverforestDark", swatch: "#a7c080" },
  { id: "everforest-light", label: "settings.themeEverforestLight", swatch: "#56682d" },
  { id: "github-dark", label: "settings.themeGithubDark", swatch: "#58a6ff" },
  { id: "github-light", label: "settings.themeGithubLight", swatch: "#0963cb" },
  { id: "gruvbox-dark", label: "settings.themeGruvboxDark", swatch: "#e0a431" },
  { id: "gruvbox-light", label: "settings.themeGruvboxLight", swatch: "#785a0d" },
  { id: "material-lighter", label: "settings.themeMaterialLighter", swatch: "#642fff" },
  { id: "material-ocean", label: "settings.themeMaterialOcean", swatch: "#9bbaff" },
  { id: "monokai", label: "settings.themeMonokai", swatch: "#fd971f" },
  { id: "night-owl", label: "settings.themeNightOwl", swatch: "#82aaff" },
  { id: "nord", label: "settings.themeNord", swatch: "#94c6d3" },
  { id: "one-dark", label: "settings.themeOneDark", swatch: "#75b7f0" },
  { id: "poimandres", label: "settings.themePoimandres", swatch: "#add7ff" },
  { id: "rose-pine", label: "settings.themeRosePine", swatch: "#c4a7e7" },
  { id: "rose-pine-dawn", label: "settings.themeRosePineDawn", swatch: "#ab3632" },
  { id: "solarized-dark", label: "settings.themeSolarizedDark", swatch: "#66aee7" },
  { id: "solarized-light", label: "settings.themeSolarizedLight", swatch: "#19649e" },
  { id: "tokyo-day", label: "settings.themeTokyoDay", swatch: "#2857a6" },
  { id: "tokyo-night", label: "settings.themeTokyoNight", swatch: "#7aa2f7" },
  { id: "vercel", label: "settings.themeVercel", swatch: "#3b92ff" },
  { id: "auto", label: "settings.themeSystem", swatch: "" },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["id"];
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

// Single source of truth for which palettes are dark: the class toggle in the
// pre-paint script and isDarkTheme must agree, or the first paint flashes the
// wrong colour scheme.
export const DARK_THEMES = ["ayu-dark", "catppuccin-mocha", "codex-dark", "dark", "dracula", "ember", "everforest-dark", "github-dark", "gruvbox-dark", "material-ocean", "monokai", "night-owl", "nord", "one-dark", "pine", "poimandres", "rose-pine", "slate", "solarized-dark", "tokyo-night", "vercel"] as const satisfies readonly ResolvedTheme[];

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return (DARK_THEMES as readonly string[]).includes(theme);
}

// Apply the saved palette before first paint, including when storage is blocked.
export const THEME_INIT_SCRIPT = `(function(){var t="auto";try{var s=localStorage.getItem("pi-theme");if(${JSON.stringify(THEME_OPTIONS.map((option) => option.id))}.includes(s))t=s}catch(e){}if(t==="auto")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.classList.toggle("dark",${JSON.stringify(DARK_THEMES)}.includes(t))})();`;
