// Centralized dark theme for Tap Story.
//
// The visual language is a deep, near-black stage with a violet accent — the
// same violet used for timeline segments — so recording feels like laying
// light down on a dark surface. Semantic state colors (record/wait/success/
// error) stay consistent everywhere they appear.

export const colors = {
  // Backgrounds — layered from the base stage up to raised cards
  background: '#0A0A0F', // Near-black with a hint of violet
  surface: '#16161F', // Cards, list items
  surfaceRaised: '#1F1F2B', // Buttons, pressed/elevated surfaces
  surfaceSunken: '#101017', // Insets like the timeline well

  // Text
  textPrimary: '#F5F5F7',
  textSecondary: '#9A9AA8',
  textTertiary: '#63636F',

  // Brand accent (violet) — links, primary actions, timeline segments
  primary: '#8B5CF6', // Violet-500
  primaryBright: '#A78BFA', // Violet-400 — highlights, playing glow
  primaryDeep: '#6D28D9', // Violet-700 — pressed/darker fills
  onPrimary: '#FFFFFF',

  // Semantic states
  recording: '#F43F5E', // Rose — recording
  waiting: '#F59E0B', // Amber — armed / waiting for punch
  success: '#34D399', // Emerald — saved / native engine ready
  error: '#F87171', // Soft red — error text

  // Timeline segment colors (rotating palette)
  trackColors: [
    '#8B5CF6', // Violet
    '#F59E0B', // Amber
    '#34D399', // Emerald
    '#38BDF8', // Sky
    '#FB7185', // Rose
    '#C084FC', // Purple
    '#FBBF24', // Yellow
  ],

  // Borders / dividers
  border: '#2A2A38',
  borderStrong: '#3A3A4C',

  // Overlays
  overlay: 'rgba(10, 10, 15, 0.82)',
};

// Spacing scale (4pt base)
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

// Corner radii
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
};

// Type scale
export const typography = {
  display: { fontSize: 34, fontWeight: '700' as const, letterSpacing: 0.2 },
  title: { fontSize: 22, fontWeight: '700' as const },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.3 },
  caption: { fontSize: 12, fontWeight: '500' as const },
};
