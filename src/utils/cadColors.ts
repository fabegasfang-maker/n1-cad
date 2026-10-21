/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { aciToHex } from './aciPalette';
import { ThemeMode } from '../types/cad';

/**
 * Standard AutoCAD color mapping helper
 */
export function getCadColor(colorIndex: number, fallback?: string, isDark: boolean = true): string {
  if (colorIndex === 7) {
    return isDark ? '#ffffff' : '#000000';
  }
  const hex = aciToHex(colorIndex);
  if (hex) return hex;
  return fallback ?? (isDark ? '#ffffff' : '#000000');
}

/**
 * Parse hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleanHex = hex.replace('#', '').trim();
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return { r, g, b };
  }
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

/**
 * Calculate relative luminance (ITU-R BT.709)
 */
function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/**
 * Adjust color for dark / blueprint / light theme background contrast
 * Preserves true CAD colors (Red, Green, Blue, Cyan, Magenta, Yellow, ACI hues)
 * without turning blue or dark lines into gray/white.
 */
export function getContrastedCadColor(
  rawColor: string,
  theme: ThemeMode,
  defaultStroke: string = '#ffffff'
): string {
  if (!rawColor || rawColor === 'none') return defaultStroke;

  const lower = rawColor.toLowerCase();

  if (theme === 'dark') {
    // In AutoCAD dark background: only pure black or near-black is inverted to white
    if (lower === '#000000' || lower === 'black' || lower === '#000') {
      return '#f8fafc';
    }
    const rgb = hexToRgb(rawColor);
    if (rgb && rgb.r < 22 && rgb.g < 22 && rgb.b < 22) {
      return '#f8fafc';
    }
    // Retain exact CAD color (Blue stays Blue, Red stays Red, etc.)
    return rawColor;
  }

  if (theme === 'blueprint') {
    // Blueprint background is #0a2342 (navy)
    if (lower === '#000000' || lower === 'black' || lower === '#000') {
      return '#e0f2fe';
    }
    const rgb = hexToRgb(rawColor);
    if (rgb && rgb.r < 22 && rgb.g < 22 && rgb.b < 22) {
      return '#e0f2fe';
    }
    // If color is very dark navy nearly identical to blueprint bg (#0a2342), brighten while preserving blue hue
    if (rgb && rgb.r < 30 && rgb.g < 50 && rgb.b > 80 && rgb.b < 150) {
      return '#60a5fa';
    }
    return rawColor;
  }

  // Light theme (white paper background)
  if (lower === '#ffffff' || lower === 'white' || lower === '#fff') {
    return '#0f172a';
  }
  const rgb = hexToRgb(rawColor);
  if (rgb && rgb.r > 240 && rgb.g > 240 && rgb.b > 240) {
    return '#0f172a';
  }
  // Pure yellow (#FFFF00) is illegible on white paper, shift slightly to amber-gold
  if (lower === '#ffff00' || lower === '#fffe00') {
    return '#b45309';
  }

  return rawColor;
}
