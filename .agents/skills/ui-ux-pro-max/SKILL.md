---
name: ui-ux-pro-max
description: World-class UI/UX Pro Max design skill providing guidelines, aesthetic rules, glassmorphism, dynamic animations, accessibility standards, color palettes, and component patterns for premium web applications.
---

# UI/UX Pro Max Design System & Skill Instructions

## Overview
UI/UX Pro Max is an advanced design skill for engineering stunning, accessible, visually captivating web interfaces with micro-interactions, responsive architecture, and dynamic themes.

## Key Principles
1. **Visual Hierarchy & Wow Factor**: Use curated color palettes (dark modes, vibrant HSL gradients, glassmorphic frosted cards) instead of default browser colors.
2. **Typography**: Load modern Google Fonts like `Inter`, `Outfit`, or `Plus Jakarta Sans`. Maintain consistent hierarchy.
3. **Glassmorphism & Depth**:
   - `background: rgba(255, 255, 255, 0.05)` (or dark equivalent)
   - `backdrop-filter: blur(16px)`
   - `border: 1px solid rgba(255, 255, 255, 0.1)`
   - Soft multi-layered box shadows: `0 8px 32px 0 rgba(0, 0, 0, 0.37)`
4. **Micro-Animations & Transitions**:
   - `transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1)`
   - Smooth hover scaling (`transform: translateY(-2px) scale(1.02)`)
   - Pulsing glowing gradients on active CTA buttons.
5. **Accessibility (WCAG AA standard)**:
   - Ensure high contrast ratios for text vs background.
   - Descriptive `aria-label` and `id` attributes on all interactive elements.

## Design Tokens & Theme Template
```css
:root {
  --bg-primary: #0b0f19;
  --bg-secondary: #111827;
  --bg-card: rgba(17, 24, 39, 0.7);
  --accent-primary: #6366f1;
  --accent-secondary: #ec4899;
  --accent-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
  --text-main: #f9fafb;
  --text-muted: #9ca3af;
  --border-glass: rgba(255, 255, 255, 0.1);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
}
```
