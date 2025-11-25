// Centralized dark theme colors for the app

export const colors = {
  // Backgrounds
  background: '#000000', // Pure black - main app background
  surface: '#1C1C1E', // Slightly elevated surfaces (cards, list items)

  // Text
  textPrimary: '#FFFFFF', // Main text
  textSecondary: '#8E8E93', // Muted/hint text
  textTertiary: '#636366', // Even more muted

  // Accent colors (iOS system colors)
  primary: '#007AFF', // Blue - buttons, links
  recording: '#FF3B30', // Red - recording state
  waiting: '#FF9500', // Orange - waiting state

  // Timeline segment colors (rotating palette)
  trackColors: [
    '#007AFF', // Blue
    '#FF9500', // Orange
    '#34C759', // Green
    '#AF52DE', // Purple
    '#5AC8FA', // Light Blue
    '#FFCC00', // Yellow
    '#FF2D55', // Pink
  ],

  // Borders/dividers
  border: '#38383A', // Subtle dark borders
};
