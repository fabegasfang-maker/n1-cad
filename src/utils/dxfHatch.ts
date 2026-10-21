/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dxf-parser ไม่รองรับ HATCH (ข้ามทิ้งเงียบๆ) ทำให้พื้นทึบของสัญลักษณ์ เช่น หม้อแปลงสีแดง
 * จุดวงกลมสีเหลือง หัวลูกศร หายไปจากแผนผัง ไฟล์นี้อ่าน HATCH เองจากข้อความ DXF โดยตรง
 * ทั้งใน ENTITIES และใน BLOCKS
 */

import type { Point2D } from '../types/cad';

export interface RawHatch {
  layer: string;
  colorIndex?: number;
  trueColor?: number;
  solid: boolean;
  loops: Point2D[][];
}

export interface ExtractedHatches {
  model: RawHatch[];
  blocks: Record<string, RawHatch[]>; // key = ชื่อบล็อก (ตัวพิมพ์ใหญ่)
}

type Pair = [number, string];

function arcPoints(cx: number, cy: number, r: number, aStartDeg: number, aEndDeg: number, ccw: boolean): Point2D[] {
  let a0 = (aStartDeg * Math.PI) / 180;
  let a1 = (aEndDeg * Math.PI) / 180;
  if (ccw) {
    while (a1 <= a0) a1 += Math.PI * 2;
  } else {
    while (a1 >= a0) a1 -= Math.PI * 2;
  }
  const steps = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18)));
  const pts: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function bulgeSegment(p1: Point2D, p2: Point2D, bulge: number): Point2D[] {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!bulge || dist < 1e-9) return [p2];
  const theta = 4 * Math.atan(bulge);
  const r = dist / (2 * Math.sin(theta / 2));
  const chord = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const toCenter = chord + (Math.PI - theta) / 2;
  const cx = p1.x + r * Math.cos(toCenter);
  const cy = p1.y + r * Math.sin(toCenter);
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const steps = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 18)));
  const out: Point2D[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (theta * i) / steps;
    out.push({ x: cx + Math.abs(r) * Math.cos(a), y: cy + Math.abs(r) * Math.sin(a) });
  }
  return out;
}

function bsplinePoints(ctrl: Point2D[], knots: number[], degree: number): Point2D[] {
  const n = ctrl.length;
  if (n < 2) return ctrl;
  if (degree < 1 || knots.length !== n + degree + 1 || n <= degree) return ctrl;
  const t0 = knots[degree];
  const t1 = knots[n];
  if (!(t1 > t0)) return ctrl;
  const samples = Math.min(Math.max(n * 6, 16), 200);
  const out: Point2D[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 : t0 + ((t1 - t0) * s) / samples;
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d: Point2D[] = [];
    for (let j = 0; j <= degree; j++) d.push({ ...ctrl[j + k - degree] });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const den = knots[j + 1 + k - r] - knots[j + k - degree];
        const a = den === 0 ? 0 : (t - knots[j + k - degree]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    out.push(d[degree]);
  }
  return out;
}

function parseOneHatch(pairs: Pair[]): RawHatch | null {
  let layer = '0';
  let colorIndex: number | undefined;
  let trueColor: number | undefined;
  let solid = false;
  let patternName = '';
  const loops: Point2D[][] = [];

  // ส่วนหัว: อ่านจนถึงรหัส 91 (จำนวน boundary path)
  let i = 0;
  let nPaths = 0;
  for (; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 8) layer = v;
    else if (c === 62) colorIndex = parseInt(v, 10);
    else if (c === 420) trueColor = parseInt(v, 10);
    else if (c === 2) patternName = v.trim();
    else if (c === 70) solid = parseInt(v, 10) === 1;
    else if (c === 91) {
      nPaths = parseInt(v, 10);
      i++;
      break;
    }
  }
  if (patternName.toUpperCase() === 'SOLID') solid = true;

  // helper: เดินไปหา code ถัดไปที่ต้องการ
  const seek = (code: number): string | undefined => {
    while (i < pairs.length) {
      const [c, v] = pairs[i++];
      if (c === code) return v;
    }
    return undefined;
  };
  const peekCode = (): number | undefined => (i < pairs.length ? pairs[i][0] : undefined);

  for (let p = 0; p < nPaths; p++) {
    const flagStr = seek(92);
    if (flagStr === undefined) break;
    const flags = parseInt(flagStr, 10);
    const pts: Point2D[] = [];

    if (flags & 2) {
      // polyline path
      const hasBulge = parseInt(seek(72) ?? '0', 10) !== 0;
      const closed = parseInt(seek(73) ?? '1', 10) !== 0;
      const nV = parseInt(seek(93) ?? '0', 10);
      const verts: { x: number; y: number; b: number }[] = [];
      for (let k = 0; k < nV; k++) {
        const x = parseFloat(seek(10) ?? '0');
        const y = parseFloat(seek(20) ?? '0');
        let b = 0;
        if (hasBulge && peekCode() === 42) b = parseFloat(seek(42) ?? '0');
        verts.push({ x, y, b });
      }
      for (let k = 0; k < verts.length; k++) {
        const a = verts[k];
        pts.push({ x: a.x, y: a.y });
        const isLast = k === verts.length - 1;
        if (a.b && (!isLast || closed)) {
          const nxt = verts[(k + 1) % verts.length];
          const seg = bulgeSegment(a, nxt, a.b);
          // ตัดจุดสุดท้ายออก เพราะเป็นจุดเริ่มของเส้นถัดไป
          for (let q = 0; q < seg.length - 1; q++) pts.push(seg[q]);
        }
      }
    } else {
      const nE = parseInt(seek(93) ?? '0', 10);
      for (let e = 0; e < nE; e++) {
        const type = parseInt(seek(72) ?? '0', 10);
        if (type === 1) {
          const x1 = parseFloat(seek(10) ?? '0');
          const y1 = parseFloat(seek(20) ?? '0');
          const x2 = parseFloat(seek(11) ?? '0');
          const y2 = parseFloat(seek(21) ?? '0');
          pts.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        } else if (type === 2) {
          const cx = parseFloat(seek(10) ?? '0');
          const cy = parseFloat(seek(20) ?? '0');
          const r = parseFloat(seek(40) ?? '0');
          const a0 = parseFloat(seek(50) ?? '0');
          const a1 = parseFloat(seek(51) ?? '360');
          const ccw = parseInt(seek(73) ?? '1', 10) !== 0;
          pts.push(...arcPoints(cx, cy, r, a0, a1, ccw));
        } else if (type === 3) {
          const cx = parseFloat(seek(10) ?? '0');
          const cy = parseFloat(seek(20) ?? '0');
          const mx = parseFloat(seek(11) ?? '1');
          const my = parseFloat(seek(21) ?? '0');
          const ratio = parseFloat(seek(40) ?? '1');
          const a0 = (parseFloat(seek(50) ?? '0') * Math.PI) / 180;
          let a1 = (parseFloat(seek(51) ?? '360') * Math.PI) / 180;
          const ccw = parseInt(seek(73) ?? '1', 10) !== 0;
          if (ccw) while (a1 <= a0) a1 += Math.PI * 2;
          else while (a1 >= a0) a1 -= Math.PI * 2;
          const rMaj = Math.hypot(mx, my);
          const rMin = rMaj * ratio;
          const rot = Math.atan2(my, mx);
          const steps = Math.max(12, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18)));
          for (let s = 0; s <= steps; s++) {
            const t = a0 + ((a1 - a0) * s) / steps;
            const ex = rMaj * Math.cos(t);
            const ey = rMin * Math.sin(t);
            pts.push({ x: cx + ex * Math.cos(rot) - ey * Math.sin(rot), y: cy + ex * Math.sin(rot) + ey * Math.cos(rot) });
          }
        } else if (type === 4) {
          const degree = parseInt(seek(94) ?? '3', 10);
          const rational = parseInt(seek(73) ?? '0', 10) !== 0;
          seek(74); // periodic
          const nK = parseInt(seek(95) ?? '0', 10);
          const nC = parseInt(seek(96) ?? '0', 10);
          const knots: number[] = [];
          for (let k = 0; k < nK; k++) knots.push(parseFloat(seek(40) ?? '0'));
          const ctrl: Point2D[] = [];
          for (let k = 0; k < nC; k++) {
            const x = parseFloat(seek(10) ?? '0');
            const y = parseFloat(seek(20) ?? '0');
            if (rational && peekCode() === 42) seek(42);
            ctrl.push({ x, y });
          }
          pts.push(...bsplinePoints(ctrl, knots, degree));
        } else {
          break; // ไม่รู้จักชนิด edge — เลิกอ่าน path นี้
        }
      }
    }

    // source boundary objects: 97 + n × 330
    if (peekCode() === 97) {
      const n = parseInt(seek(97) ?? '0', 10);
      for (let k = 0; k < n && peekCode() === 330; k++) i++;
    }
    if (pts.length >= 3) loops.push(pts);
  }

  if (loops.length === 0) return null;
  return { layer, colorIndex, trueColor, solid, loops };
}

export function extractHatches(dxf: string): ExtractedHatches {
  const result: ExtractedHatches = { model: [], blocks: {} };
  if (!dxf.includes('HATCH')) return result;

  const lines = dxf.split(/\r\n|\r|\n/);
  let section = '';
  let currentBlock = '';
  let blockNameNext = false;
  let hatchPairs: Pair[] | null = null;
  let inEntityHeader = false;

  const flush = () => {
    if (!hatchPairs) return;
    const h = parseOneHatch(hatchPairs);
    hatchPairs = null;
    if (!h) return;
    if (section === 'ENTITIES') result.model.push(h);
    else if (section === 'BLOCKS' && currentBlock) (result.blocks[currentBlock] ||= []).push(h);
  };

  for (let li = 0; li + 1 < lines.length; li += 2) {
    const code = parseInt(lines[li].trim(), 10);
    const val = lines[li + 1].trim();
    if (Number.isNaN(code)) continue;

    if (code === 0) {
      flush();
      inEntityHeader = false;
      if (val === 'SECTION') continue;
      if (val === 'ENDSEC') {
        section = '';
        continue;
      }
      if (val === 'BLOCK') {
        blockNameNext = true;
        currentBlock = '';
        continue;
      }
      if (val === 'ENDBLK') {
        currentBlock = '';
        continue;
      }
      if (val === 'HATCH' && (section === 'ENTITIES' || (section === 'BLOCKS' && currentBlock))) {
        hatchPairs = [];
        inEntityHeader = true;
      }
      continue;
    }

    if (code === 2 && (val === 'ENTITIES' || val === 'BLOCKS' || val === 'TABLES' || val === 'HEADER' || val === 'CLASSES' || val === 'OBJECTS') && section === '') {
      section = val;
      continue;
    }
    if (blockNameNext && code === 2) {
      currentBlock = val.toUpperCase();
      blockNameNext = false;
      continue;
    }
    if (hatchPairs && inEntityHeader !== undefined) hatchPairs.push([code, val]);
  }
  flush();
  return result;
}
