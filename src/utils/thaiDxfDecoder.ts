/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getCadColor as getAciHex } from './cadColors';
import { aciToHex } from './aciPalette';

/**
 * Windows-874 / TIS-620 byte fallback table to Unicode codepoints (0x80 - 0xFF).
 * For bytes 0x00 - 0x7F, it's standard ASCII.
 */
const WINDOWS_874_TABLE: number[] = [
  // 0x80 - 0x8F
  0x20AC, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0x2026, 0xFFFD, 0xFFFD,
  0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD,
  // 0x90 - 0x9F
  0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD,
  // 0xA0 - 0xAF (0xA1 = U+0E01 ก)
  0x00A0, 0x0E01, 0x0E02, 0x0E03, 0x0E04, 0x0E05, 0x0E06, 0x0E07,
  0x0E08, 0x0E09, 0x0E0A, 0x0E0B, 0x0E0C, 0x0E0D, 0x0E0E, 0x0E0F,
  // 0xB0 - 0xBF
  0x0E10, 0x0E11, 0x0E12, 0x0E13, 0x0E14, 0x0E15, 0x0E16, 0x0E17,
  0x0E18, 0x0E19, 0x0E1A, 0x0E1B, 0x0E1C, 0x0E1D, 0x0E1E, 0x0E1F,
  // 0xC0 - 0xCF
  0x0E20, 0x0E21, 0x0E22, 0x0E23, 0x0E24, 0x0E25, 0x0E26, 0x0E27,
  0x0E28, 0x0E29, 0x0E2A, 0x0E2B, 0x0E2C, 0x0E2D, 0x0E2E, 0x0E2F,
  // 0xD0 - 0xDF
  0x0E30, 0x0E31, 0x0E32, 0x0E33, 0x0E34, 0x0E35, 0x0E36, 0x0E37,
  0x0E38, 0x0E39, 0x0E3A, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD, 0x0E3F,
  // 0xE0 - 0xEF
  0x0E40, 0x0E41, 0x0E42, 0x0E43, 0x0E44, 0x0E45, 0x0E46, 0x0E47,
  0x0E48, 0x0E49, 0x0E4A, 0x0E4B, 0x0E4C, 0x0E4D, 0x0E4E, 0x0E4F,
  // 0xF0 - 0xFF
  0x0E50, 0x0E51, 0x0E52, 0x0E53, 0x0E54, 0x0E55, 0x0E56, 0x0E57,
  0x0E58, 0x0E59, 0x0E5A, 0x0E5B, 0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD,
];

/**
 * Decode an ArrayBuffer or Uint8Array using Windows-874 / TIS-620.
 */
export function decodeWindows874(bytes: Uint8Array): string {
  try {
    const decoder = new TextDecoder('windows-874');
    return decoder.decode(bytes);
  } catch {
    // Manual fallback using lookup table
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) {
        result += String.fromCharCode(b);
      } else {
        const code = WINDOWS_874_TABLE[b - 0x80] ?? 0xFFFD;
        result += String.fromCharCode(code);
      }
    }
    return result;
  }
}

/**
 * Detect DWG/DXF codepage from raw buffer or string header.
 */
export function detectCodepageFromHeader(buffer: ArrayBuffer): {
  detectedCodepage: string;
  recommendedEncoding: 'utf-8' | 'windows-874' | 'iso-8859-1';
} {
  // Read first 16KB of buffer as raw ASCII to scan for $DWGCODEPAGE
  const slice = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16384));
  let ascii = '';
  for (let i = 0; i < slice.length; i++) {
    ascii += String.fromCharCode(slice[i]);
  }

  // DXF ตั้งแต่ AutoCAD 2007 (AC1021) ขึ้นไปเป็น UTF-8 เสมอ แม้ header จะระบุ $DWGCODEPAGE เป็น ANSI_874
  // (ไฟล์ที่แปลงจาก DWG ด้วย LibreDWG ก็เขียนเป็น UTF-8) — ถ้าไปถอดเป็น windows-874 ภาษาไทยจะเพี้ยนเป็นขยะ
  // และข้อความขยะจำนวนมากจะบังเส้นทั้งแผนผัง
  const earlyVer = ascii.match(/\$ACADVER\s+1\s+AC(\d+)/i);
  if (earlyVer && parseInt(earlyVer[1], 10) >= 1021) {
    const cpTag = ascii.match(/\$DWGCODEPAGE\s+3\s+([A-Za-z0-9_-]+)/i);
    return { detectedCodepage: cpTag ? `${cpTag[1].toUpperCase()} (ไฟล์ DXF 2007+ = UTF-8)` : 'UTF-8 (AutoCAD 2007+)', recommendedEncoding: 'utf-8' };
  }

  const codepageMatch = ascii.match(/\$DWGCODEPAGE\s+3\s+([A-Za-z0-9_-]+)/i);
  if (codepageMatch && codepageMatch[1]) {
    const cp = codepageMatch[1].trim().toUpperCase();
    if (cp.includes('874') || cp.includes('TIS') || cp.includes('THAI')) {
      return { detectedCodepage: cp, recommendedEncoding: 'windows-874' };
    }
    if (cp.includes('UTF') || cp.includes('UNICODE')) {
      return { detectedCodepage: cp, recommendedEncoding: 'utf-8' };
    }
    if (cp.includes('1252') || cp.includes('LATIN') || cp.includes('ANSI')) {
      return { detectedCodepage: cp, recommendedEncoding: 'iso-8859-1' };
    }
    return { detectedCodepage: cp, recommendedEncoding: 'utf-8' };
  }

  // Check version header $ACADVER
  const verMatch = ascii.match(/\$ACADVER\s+1\s+(AC[0-9]+)/i);
  if (verMatch && verMatch[1]) {
    const acadVer = verMatch[1].toUpperCase();
    // AC1021 is AutoCAD 2007; versions >= AC1021 default to UTF-8
    const verNum = parseInt(acadVer.replace('AC', ''), 10);
    if (!isNaN(verNum) && verNum < 1021) {
      // Pre-2007 CAD drawing without explicit UTF-8 tag often uses Windows-874 if created in Thailand
      return { detectedCodepage: `${acadVer} (Pre-2007 CAD)`, recommendedEncoding: 'windows-874' };
    }
    return { detectedCodepage: `${acadVer} (AutoCAD 2007+ Unicode)`, recommendedEncoding: 'utf-8' };
  }

  return { detectedCodepage: 'Auto-detected UTF-8', recommendedEncoding: 'utf-8' };
}

/**
 * Decode ArrayBuffer based on chosen encoding format.
 */
export function decodeDxfBuffer(buffer: ArrayBuffer, encoding: 'utf-8' | 'windows-874' | 'iso-8859-1'): string {
  const bytes = new Uint8Array(buffer);
  if (encoding === 'windows-874') {
    return decodeWindows874(bytes);
  }
  if (encoding === 'iso-8859-1') {
    const decoder = new TextDecoder('iso-8859-1');
    return decoder.decode(bytes);
  }
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes);
}

/**
 * Decodes AutoCAD unicode escape sequence \U+XXXX (e.g. \U+0E01 -> ก)
 * and AutoCAD legacy symbol codes (%%c, %%d, %%p, %%%).
 */
export function decodeAutoCadEscapes(input: string): string {
  if (!input) return '';

  let text = input;

  // 1. Replace \U+XXXX or \u+xxxx (AutoCAD Unicode escapes)
  // e.g. \U+0E01 => ก
  text = text.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => {
    try {
      const charCode = parseInt(hex, 16);
      return String.fromCharCode(charCode);
    } catch {
      return _;
    }
  });

  // Also support lowercase \u+xxxx
  text = text.replace(/\\u\+([0-9A-Fa-f]{4})/g, (_, hex) => {
    try {
      const charCode = parseInt(hex, 16);
      return String.fromCharCode(charCode);
    } catch {
      return _;
    }
  });

  // 2. Replace AutoCAD special symbol codes
  // %%c = Diameter symbol (⌀)
  // %%d = Degree symbol (°)
  // %%p = Plus/minus symbol (±)
  // %%% = Percent sign (%)
  // %%u = Toggle underline
  // %%o = Toggle overline
  text = text.replace(/%%[cC]/g, '⌀');
  text = text.replace(/%%[dD]/g, '°');
  text = text.replace(/%%[pP]/g, '±');
  text = text.replace(/%%%/g, '%');
  text = text.replace(/%%[uUoO]/g, ''); // strip underline/overline markers

  return text;
}

/**
 * Clean and format MTEXT formatting codes from DXF.
 * Handles:
 * \P -> newline
 * \f...; -> font specification
 * \C...; -> color specification
 * \H...; -> height specification
 * \W...; -> width factor
 * \Q...; -> slant / obliquing
 * \T...; -> tracking
 * \A...; -> alignment
 * \S...^...; -> fractions
 * \{, \} -> braces
 * Grouping curly brackets { ... }
 */
export function parseAndCleanMText(input: string): {
  cleanedText: string;
  lines: string[];
  extractedFonts: string[];
  extractedColor?: string;
} {
  if (!input) {
    return { cleanedText: '', lines: [''], extractedFonts: [] };
  }

  // First decode unicode escapes (\U+XXXX) and symbols (%%c, etc.)
  let text = decodeAutoCadEscapes(input);

  const extractedFonts: string[] = [];

  // Extract font references if any (e.g. \fAngsana New|b0|i0|c222|p34;)
  const fontMatches = text.match(/\\f([^;|]+)/gi);
  if (fontMatches) {
    for (const fm of fontMatches) {
      const cleanedFont = fm.replace(/\\f/i, '').trim();
      if (cleanedFont && !extractedFonts.includes(cleanedFont)) {
        extractedFonts.push(cleanedFont);
      }
    }
  }

  // สีฝังในข้อความ: \C<ACI>; หรือ \c<RGB int>; — เก็บค่าแรกไว้ใช้เป็นสีข้อความ
  let extractedColor: string | undefined;
  const cMatch = text.match(/\\([Cc])(\d+);/);
  if (cMatch) {
    const n = parseInt(cMatch[2], 10);
    if (cMatch[1] === 'c') {
      // \c เป็นเลข RGB (ลำดับ BGR ในบางไฟล์ แต่ AutoCAD ใช้ 0xBBGGRR)
      const r = n & 0xff, g = (n >> 8) & 0xff, b = (n >> 16) & 0xff;
      extractedColor = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    } else if (n > 0 && n < 256) {
      extractedColor = aciToHex(n) ?? getAciHex(n, undefined, true);
    }
  }

  // \p...; = พารามิเตอร์ย่อหน้า (ตัวพิมพ์เล็ก) ต้องลบทิ้งทั้งก้อน ไม่ใช่แปลงเป็นบรรทัดใหม่
  // (โค้ดเดิมแปลง \p เป็น \n แล้วเหลือ "i1.17;" ค้างหน้าข้อความ)
  text = text.replace(/\\p[^;\\]*;/g, '');
  // \P (ตัวพิมพ์ใหญ่) = ขึ้นบรรทัดใหม่
  text = text.replace(/\\P/g, '\n');
  // \L \l \O \o \K \k = ขีดเส้นใต้/ขีดฆ่า ไม่มี ; ปิดท้าย
  text = text.replace(/\\[LlOoKk]/g, '');

  // Replace stacked fractions \S A^B; or \S A/B; or \S A#B; with A/B
  text = text.replace(/\\S([^;^/#]+)[\^/#]([^;]+);/gi, '$1/$2');

  // Strip font specification \f...; or \F...;
  text = text.replace(/\\f[^;]+;/gi, '');

  // Strip color codes \C...; or \c...;
  text = text.replace(/\\c[0-9]+;/gi, '');

  // Strip height codes \H...; or \H...x;
  text = text.replace(/\\h[0-9.]+(x)?;/gi, '');

  // Strip width factor \W...;
  text = text.replace(/\\w[0-9.]+;/gi, '');

  // Strip obliquing angle \Q...;
  text = text.replace(/\\q[0-9.-]+;/gi, '');

  // Strip tracking \T...;
  text = text.replace(/\\t[0-9.]+;/gi, '');

  // Strip alignment \A...;
  text = text.replace(/\\a[0-9]+;/gi, '');

  // Strip other unknown formatting codes \X...;
  text = text.replace(/\\[A-Za-z][^;]*;/g, '');

  // Strip remaining solitary formatting escapes
  text = text.replace(/\\~/g, ' '); // non-breaking space
  text = text.replace(/\\{/g, '{');
  text = text.replace(/\\}/g, '}');
  text = text.replace(/\\\\/g, '\\');

  // Remove grouping braces { and } that wrap formatted segments
  // e.g. {\fAngsana;Text} => Text
  text = text.replace(/[{}]/g, '');

  // Split into lines
  const lines = text.split('\n');

  return {
    extractedColor,
    cleanedText: text,
    lines,
    extractedFonts,
  };
}

/**
 * Re-encode Thai text to DXF \U+XXXX escape sequence format.
 * Useful for debugging, export, or inspecting how AutoCAD represents Thai text.
 */
export function encodeThaiToDxfEscapes(input: string): string {
  if (!input) return '';
  let result = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Thai Unicode block is 0x0E01 - 0x0E5B
    if (code >= 0x0E01 && code <= 0x0E5B) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      result += `\\U+${hex}`;
    } else {
      result += input[i];
    }
  }
  return result;
}
