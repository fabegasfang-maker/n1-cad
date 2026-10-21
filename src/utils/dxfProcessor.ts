/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import DxfParser from 'dxf-parser';
import {
  BoundingBox,
  CadEntity,
  CadLayer,
  ParsedCadModel,
  Point2D,
} from '../types/cad';
import { getCadColor } from './cadColors';
import { aciToHex } from './aciPalette';
import { parseDxfWithFallback } from './dxfFallbackParser';
import { extractHatches, RawHatch } from './dxfHatch';
import {
  decodeAutoCadEscapes,
  detectCodepageFromHeader,
  decodeDxfBuffer,
  parseAndCleanMText,
} from './thaiDxfDecoder';

/**
 * Interpolates a polyline arc segment given two vertices and an AutoCAD bulge factor.
 * Bulge = tan(included angle / 4)
 */
function interpolateBulge(p1: Point2D, p2: Point2D, bulge: number, segments = 0): Point2D[] {
  if (!bulge || Math.abs(bulge) < 1e-4) {
    return [p2];
  }

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return [p2];

  const includedAngle = 4 * Math.atan(bulge);
  if (!segments) segments = Math.max(4, Math.ceil(Math.abs(includedAngle) / (Math.PI / 18))); // ~10° ต่อช่วง
  const radius = dist / (2 * Math.sin(includedAngle / 2));
  const chordAngle = Math.atan2(dy, dx);
  const angleToCenter = chordAngle + (Math.PI - includedAngle) / 2;

  const cx = p1.x + radius * Math.cos(angleToCenter);
  const cy = p1.y + radius * Math.sin(angleToCenter);

  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  let sweep = includedAngle;

  const pts: Point2D[] = [];
  for (let s = 1; s <= segments; s++) {
    const fraction = s / segments;
    const curA = startAngle + sweep * fraction;
    pts.push({
      x: cx + Math.abs(radius) * Math.cos(curA),
      y: cy + Math.abs(radius) * Math.sin(curA),
    });
  }
  return pts;
}

/** แปลงเลข RGB (0xRRGGBB) จาก dxf-parser เป็น #rrggbb */
function rgbIntToHex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * หาสีของเอนทิตีให้ถูกต้อง
 * dxf-parser ให้ `colorIndex` (ACI) และ `color` (เลข RGB แบบ int ซึ่งอาจมาจาก true color 420)
 * โค้ดเดิมอ่าน `colorNumber` ซึ่งไม่มีอยู่จริง แล้วเอาเลข RGB ไปตีความเป็น ACI จึงได้สีเทาทุกเส้น
 */
function resolveEntityColor(
  raw: any,
  layerHex: string,
  byBlockHex?: string
): { hex: string; num: number } {
  const idx: number | undefined = typeof raw.colorIndex === 'number' ? Math.abs(raw.colorIndex) : undefined;
  const rgb: number | undefined = typeof raw.color === 'number' ? raw.color : undefined;

  if (idx === undefined || idx === 256) {
    // BYLAYER (ยกเว้นมี true color 420 มาทับ)
    if (rgb !== undefined && idx === undefined) return { hex: rgbIntToHex(rgb), num: 256 };
    return { hex: layerHex, num: 256 };
  }
  if (idx === 0) {
    // BYBLOCK: ใช้สีของ INSERT ที่เรียกบล็อกนี้
    return { hex: byBlockHex ?? layerHex, num: 0 };
  }
  if (rgb !== undefined) return { hex: rgbIntToHex(rgb), num: idx };
  return { hex: aciToHex(idx) ?? getCadColor(idx, undefined, true), num: idx };
}

/**
 * สุ่มจุดบนเส้น SPLINE ให้เป็นเส้นโค้งจริง
 * - ถ้ามี fit points ใช้ได้เลย (อยู่บนเส้นโค้งอยู่แล้ว)
 * - ถ้ามี control points + knots → คำนวณ B-spline (de Boor)
 * - ไม่งั้นถอยกลับไปใช้ control points (โค้ดเดิมวาดแค่เส้น control polygon ทำให้รูปร่างผิด)
 */
function sampleSpline(raw: any): Point2D[] {
  const fit = raw.fitPoints as any[] | undefined;
  if (Array.isArray(fit) && fit.length >= 2) {
    return fit.map((p) => ({ x: p.x ?? 0, y: p.y ?? 0 }));
  }
  const cps = raw.controlPoints as any[] | undefined;
  if (!Array.isArray(cps) || cps.length < 2) return [];
  const ctrl = cps.map((p) => ({ x: p.x ?? 0, y: p.y ?? 0 }));
  const knots = raw.knotValues as number[] | undefined;
  const degree: number = raw.degreeOfSplineCurve ?? 3;
  const n = ctrl.length;
  if (!Array.isArray(knots) || knots.length !== n + degree + 1 || degree < 1 || n <= degree) return ctrl;

  const t0 = knots[degree];
  const t1 = knots[n];
  if (!(t1 > t0)) return ctrl;
  const samples = Math.min(Math.max(n * 6, 16), 200);
  const out: Point2D[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i === samples ? t1 : t0 + ((t1 - t0) * i) / samples;
    // หา span k ที่ knots[k] <= t < knots[k+1]
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d: Point2D[] = [];
    for (let j = 0; j <= degree; j++) d.push({ ...ctrl[j + k - degree] });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const denom = knots[j + 1 + k - r] - knots[j + k - degree];
        const a = denom === 0 ? 0 : (t - knots[j + k - degree]) / denom;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    out.push(d[degree]);
  }
  return out;
}

export function parseDxfFromBuffer(
  buffer: ArrayBuffer,
  forcedEncoding?: 'utf-8' | 'windows-874' | 'iso-8859-1',
  filename = 'drawing.dxf'
): ParsedCadModel {
  const { detectedCodepage, recommendedEncoding } = detectCodepageFromHeader(buffer);
  const activeEncoding = forcedEncoding || recommendedEncoding;
  const decodedDxfText = decodeDxfBuffer(buffer, activeEncoding);

  return parseDxfFromString(decodedDxfText, filename, detectedCodepage, activeEncoding);
}

export function parseDxfFromString(
  dxfString: string,
  filename = 'drawing.dxf',
  detectedCodepage = 'Auto-detected',
  encodingUsed = 'utf-8'
): ParsedCadModel {
  const parser = new DxfParser();
  let dxfObj: any;

  try {
    dxfObj = parser.parseSync(dxfString);
  } catch {
    try {
      const sanitized = dxfString.replace(/^\uFEFF/, '').trim();
      dxfObj = parser.parseSync(sanitized);
    } catch (fallbackErr) {
      console.warn('dxf-parser threw fatal error, falling back to resilient line scanner:', fallbackErr);
      return parseDxfWithFallback(dxfString, filename, detectedCodepage, encodingUsed);
    }
  }

  // If parsed object has zero entities but the file has entities section, use resilient fallback
  if ((!dxfObj?.entities || dxfObj.entities.length === 0) && dxfString.includes('ENTITIES')) {
    const fbModel = parseDxfWithFallback(dxfString, filename, detectedCodepage, encodingUsed);
    if (fbModel.entities.length > 0) {
      return fbModel;
    }
  }

  // Extract layers
  const layers: Record<string, CadLayer> = {};
  const layersOffInFile = new Set<string>();
  if (dxfObj?.tables?.layer?.layers) {
    const rawLayers = dxfObj.tables.layer.layers;
    for (const key of Object.keys(rawLayers)) {
      const l = rawLayers[key];
      const layerName = l.name || key;
      const colorNum = typeof l.colorIndex === 'number' ? Math.abs(l.colorIndex) : 7;
      const layerHex = typeof l.color === 'number' ? rgbIntToHex(l.color) : (aciToHex(colorNum) ?? getCadColor(colorNum, undefined, true));
      // เลเยอร์ที่ปิด (สี ACI ติดลบ) หรือ frozen — เก็บสถานะไว้ก่อน แล้วตัดสินใจทีหลังว่าจะซ่อนหรือไม่
      if (l.visible === false || l.frozen === true) layersOffInFile.add(layerName);

      layers[layerName] = {
        name: layerName,
        colorNumber: colorNum,
        color: layerHex,
        visible: true,
        entityCount: 0,
        lineType: l.lineTypeName || 'Continuous',
      };
    }
  }

  // LibreDWG มักเขียนสีเลเยอร์เป็นค่าติดลบ (= "ปิดเลเยอร์") ให้ทุกเลเยอร์ แม้ใน DWG ต้นฉบับจะเปิดอยู่
  // ถ้าทุกเลเยอร์ "ปิด" ให้ถือว่าเป็นข้อมูลผิดพลาดและแสดงทั้งหมด แต่ถ้าปิดเฉพาะบางเลเยอร์จึงค่อยซ่อนตามไฟล์
  if (layersOffInFile.size > 0 && layersOffInFile.size < Object.keys(layers).length) {
    for (const name of layersOffInFile) layers[name].visible = false;
  }

  // Ensure default "0" layer exists
  if (!layers['0']) {
    layers['0'] = {
      name: '0',
      colorNumber: 7,
      color: '#ffffff',
      visible: true,
      entityCount: 0,
      lineType: 'Continuous',
    };
  }

  const entities: CadEntity[] = [];
  const entityCountsByType: Record<string, number> = {};

  // HATCH: dxf-parser ไม่อ่านให้ — ดึงเองจากข้อความ DXF
  const hatches = extractHatches(dxfString);

  // Linetype (เส้นประ/จุด) จากตาราง LTYPE
  const ltScale = typeof dxfObj?.header?.$LTSCALE === 'number' ? dxfObj.header.$LTSCALE : 1;
  const ltPatterns: Record<string, number[]> = {};
  const rawLt = dxfObj?.tables?.lineType?.lineTypes;
  if (rawLt) {
    for (const k of Object.keys(rawLt)) {
      const pat = rawLt[k]?.pattern;
      if (Array.isArray(pat) && pat.length > 0) ltPatterns[(rawLt[k].name || k).toUpperCase()] = pat;
    }
  }
  function dashFor(ent: any, scale: number): number[] | undefined {
    const nm = String(ent?.lineType || '').toUpperCase();
    if (!nm || nm === 'BYLAYER' || nm === 'BYBLOCK' || nm === 'CONTINUOUS') return undefined;
    const pat = ltPatterns[nm];
    if (!pat) return undefined;
    const k = Math.abs(scale) * ltScale * (typeof ent.lineTypeScale === 'number' ? ent.lineTypeScale : 1);
    return pat.map((d) => d * k);
  }
  // ตั้งค่า dash ปัจจุบัน แล้วให้ทุกเอนทิตีที่ push ถัดมาได้ dash นี้ (ยกเว้นข้อความ/พื้นทึบ)
  let ctxDash: number[] | undefined;
  const pushOrig = entities.push.bind(entities);
  entities.push = (...items: CadEntity[]) => {
    if (ctxDash) {
      for (const it of items) {
        if (it.type !== 'TEXT' && it.type !== 'MTEXT' && it.type !== 'HATCH' && it.type !== 'SOLID') it.dash = ctxDash;
      }
    }
    return pushOrig(...items);
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function updateBounds(x: number, y: number) {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Blocks dictionary lookup helper (handles case variations and array vs dictionary)
  const blocksMap: Record<string, any> = {};
  if (dxfObj?.blocks) {
    if (Array.isArray(dxfObj.blocks)) {
      for (const b of dxfObj.blocks) {
        if (b?.name) blocksMap[b.name.toUpperCase()] = b;
      }
    } else {
      for (const k of Object.keys(dxfObj.blocks)) {
        blocksMap[k.toUpperCase()] = dxfObj.blocks[k];
      }
    }
  }

  /**
   * Helper to recursively extract entities from block definitions (INSERT)
   */
  function expandBlockEntities(
    rawInsert: any,
    parentLayer: string,
    insertPos: Point2D,
    scaleX: number,
    scaleY: number,
    rotRad: number,
    depth = 0,
    insertColorHex?: string
  ) {
    if (depth > 5) return; // Prevent circular block references

    const blockName = (rawInsert.name || '').toUpperCase();
    const block = blocksMap[blockName];
    if (!block?.entities || !Array.isArray(block.entities)) return;

    const blockBase = block.position || block.basePoint || { x: 0, y: 0 };

    function transformPt(pt?: { x?: number; y?: number }): Point2D {
      const lx = (pt?.x ?? 0) - (blockBase.x ?? 0);
      const ly = (pt?.y ?? 0) - (blockBase.y ?? 0);
      const px = lx * scaleX;
      const py = ly * scaleY;
      const rx = px * Math.cos(rotRad) - py * Math.sin(rotRad);
      const ry = px * Math.sin(rotRad) + py * Math.cos(rotRad);
      return {
        x: insertPos.x + rx,
        y: insertPos.y + ry,
      };
    }

    for (let bIdx = 0; bIdx < block.entities.length; bIdx++) {
      const bEnt = block.entities[bIdx];
      const bType = (bEnt.type || '').toUpperCase();
      const bLayer = bEnt.layer && bEnt.layer !== '0' ? bEnt.layer : parentLayer;
      if (bEnt.visible === false) continue;
      ctxDash = dashFor(bEnt, Math.abs(scaleX));
      const { hex: bColor, num: bColorNum } = resolveEntityColor(
        bEnt,
        layers[bLayer]?.color ?? '#ffffff',
        insertColorHex
      );
      const subId = `${rawInsert.id || 'ins'}_blk_${depth}_${bIdx}_${bType}`;

      if (bType === 'LINE') {
        const start = transformPt(bEnt.vertices?.[0] ?? bEnt.start);
        const end = transformPt(bEnt.vertices?.[1] ?? bEnt.end);
        updateBounds(start.x, start.y);
        updateBounds(end.x, end.y);
        entities.push({
          id: subId,
          type: 'LINE',
          layer: bLayer,
          color: bColor,
          colorNumber: bColorNum,
          start,
          end,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'LWPOLYLINE' || bType === 'POLYLINE') {
        const rawVerts = bEnt.vertices;
        if (Array.isArray(rawVerts) && rawVerts.length > 0) {
          const transformedVerts: Point2D[] = [];
          for (let vi = 0; vi < rawVerts.length; vi++) {
            const curP = transformPt(rawVerts[vi]);
            transformedVerts.push(curP);
            updateBounds(curP.x, curP.y);

            // Handle bulges inside blocks
            if (rawVerts[vi].bulge && vi < rawVerts.length - 1) {
              const nextP = transformPt(rawVerts[vi + 1]);
              const arcPts = interpolateBulge(curP, nextP, rawVerts[vi].bulge);
              for (const ap of arcPts) {
                transformedVerts.push(ap);
                updateBounds(ap.x, ap.y);
              }
            }
          }

          entities.push({
            id: subId,
            type: 'LWPOLYLINE',
            layer: bLayer,
            color: bColor,
            colorNumber: bColorNum,
            vertices: transformedVerts,
            closed: !!bEnt.shape || !!bEnt.closed,
            lineWidth: (bEnt.width || 0) * Math.abs(scaleX),
            paperSpace: !!rawInsert.paperSpace,
          });
        }
      } else if (bType === 'CIRCLE') {
        const c = transformPt(bEnt.center);
        const r = (bEnt.radius ?? 1) * Math.abs((scaleX + scaleY) / 2);
        updateBounds(c.x - r, c.y - r);
        updateBounds(c.x + r, c.y + r);
        entities.push({
          id: subId,
          type: 'CIRCLE',
          layer: bLayer,
          color: bColor,
          colorNumber: bColorNum,
          center: c,
          radius: r,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'ARC') {
        const c = transformPt(bEnt.center);
        const r = (bEnt.radius ?? 1) * Math.abs((scaleX + scaleY) / 2);
        let sa = (bEnt.startAngle ?? 0) + rotRad;
        let ea = (bEnt.endAngle ?? Math.PI * 2) + rotRad;
        updateBounds(c.x - r, c.y - r);
        updateBounds(c.x + r, c.y + r);
        entities.push({
          id: subId,
          type: 'ARC',
          layer: bLayer,
          color: bColor,
          colorNumber: bColorNum,
          center: c,
          radius: r,
          startAngle: sa,
          endAngle: ea,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'ELLIPSE') {
        const center = transformPt(bEnt.center);
        const rMaj = (bEnt.majorAxisEndPoint ? Math.hypot(bEnt.majorAxisEndPoint.x, bEnt.majorAxisEndPoint.y) : 1) * Math.abs(scaleX);
        const rMin = rMaj * (bEnt.axisRatio ?? 1);
        const elRot = (bEnt.majorAxisEndPoint ? Math.atan2(bEnt.majorAxisEndPoint.y, bEnt.majorAxisEndPoint.x) : 0) + rotRad;
        const elVerts: Point2D[] = [];
        const sa = bEnt.startAngle ?? 0;
        const ea = bEnt.endAngle ?? Math.PI * 2;
        for (let s = 0; s <= 24; s++) {
          const t = sa + ((ea - sa) * s) / 24;
          const ex = rMaj * Math.cos(t);
          const ey = rMin * Math.sin(t);
          const rx = ex * Math.cos(elRot) - ey * Math.sin(elRot);
          const ry = ex * Math.sin(elRot) + ey * Math.cos(elRot);
          const pt = { x: center.x + rx, y: center.y + ry };
          elVerts.push(pt);
          updateBounds(pt.x, pt.y);
        }
        entities.push({
          id: subId,
          type: 'LWPOLYLINE',
          layer: bLayer,
          color: bColor,
          colorNumber: bColorNum,
          vertices: elVerts,
          closed: Math.abs(ea - sa) >= Math.PI * 1.99,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'SOLID' || bType === '3DFACE' || bType === 'TRACE') {
        const rawPts = bEnt.points || bEnt.vertices || [];
        if (Array.isArray(rawPts) && rawPts.length >= 3) {
          const transformedPts = rawPts.map(transformPt);
          for (const p of transformedPts) updateBounds(p.x, p.y);
          entities.push({
            id: subId,
            type: 'SOLID',
            layer: bLayer,
            color: bColor,
            points: transformedPts,
            paperSpace: !!rawInsert.paperSpace,
          });
        }
      } else if (bType === 'TEXT' || bType === 'MTEXT') {
        const pos = transformPt(bEnt.position ?? bEnt.startPoint);
        const bRaw = bEnt.text ?? bEnt.string ?? '';
        const { cleanedText, lines, extractedColor } = parseAndCleanMText(bRaw);
        const h = (bEnt.height ?? bEnt.textHeight ?? 2.5) * Math.abs(scaleY);
        updateBounds(pos.x, pos.y);
        entities.push({
          id: subId,
          type: 'MTEXT',
          layer: bLayer,
          color: bColorNum === 256 && extractedColor ? extractedColor : bColor,
          position: pos,
          rawText: bRaw,
          decodedText: cleanedText,
          lines,
          height: h,
          rotation: (bEnt.rotation ?? 0) + (rotRad * 180) / Math.PI,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'HATCH') {
        // Extract hatch boundary loops
        const loops = bEnt.boundary || bEnt.boundaries || [];
        if (Array.isArray(loops)) {
          for (let li = 0; li < loops.length; li++) {
            const loop = loops[li];
            const loopVerts: Point2D[] = [];
            const rawV = loop.vertices || loop.points || [];
            if (Array.isArray(rawV) && rawV.length >= 2) {
              for (const v of rawV) {
                const p = transformPt(v);
                loopVerts.push(p);
                updateBounds(p.x, p.y);
              }
              entities.push({
                id: `${subId}_hatch_${li}`,
                type: 'LWPOLYLINE',
                layer: bLayer,
                color: bColor,
                colorNumber: bColorNum,
                vertices: loopVerts,
                closed: true,
                paperSpace: !!rawInsert.paperSpace,
              });
            }
          }
        }
      } else if (bType === 'SPLINE') {
        const sp = sampleSpline(bEnt).map((p) => transformPt(p));
        if (sp.length > 1) {
          for (const p of sp) updateBounds(p.x, p.y);
          entities.push({
            id: subId,
            type: 'SPLINE',
            layer: bLayer,
            color: bColor,
            points: sp,
            closed: !!bEnt.closed,
            paperSpace: !!rawInsert.paperSpace,
          } as any);
        }
      } else if (bType === 'POINT') {
        const pt = transformPt(bEnt.position);
        updateBounds(pt.x, pt.y);
        entities.push({
          id: subId,
          type: 'POINT',
          layer: bLayer,
          color: bColor,
          colorNumber: bColorNum,
          position: pt,
          paperSpace: !!rawInsert.paperSpace,
        });
      } else if (bType === 'ATTRIB' || bType === 'ATTDEF') {
        const pos = transformPt(bEnt.position ?? bEnt.startPoint ?? bEnt.endPoint);
        const bRaw = bEnt.text ?? bEnt.tag ?? '';
        if (bRaw) {
          const { cleanedText, lines, extractedColor } = parseAndCleanMText(bRaw);
          const h = (bEnt.textHeight ?? bEnt.height ?? 2.5) * Math.abs(scaleY);
          updateBounds(pos.x, pos.y);
          entities.push({
            id: subId,
            type: 'TEXT',
            layer: bLayer,
            color: bColorNum === 256 && extractedColor ? extractedColor : bColor,
            position: pos,
            rawText: bRaw,
            decodedText: cleanedText,
            height: h,
            rotation: (bEnt.rotation ?? 0) + (rotRad * 180) / Math.PI,
            paperSpace: !!rawInsert.paperSpace,
          });
        }
      } else if (bType === 'INSERT') {
        // Nested block
        const nPos = transformPt(bEnt.position);
        // dxf-parser ใช้ชื่อ xScale / yScale (S ตัวใหญ่) — โค้ดเดิมอ่าน xscale จึงได้ 1 เสมอ
        const nScaleX = scaleX * (bEnt.xScale ?? bEnt.xscale ?? 1);
        const nScaleY = scaleY * (bEnt.yScale ?? bEnt.yscale ?? 1);
        const nRotRad = rotRad + ((bEnt.rotation ?? 0) * Math.PI) / 180;
        expandBlockEntities(bEnt, bLayer, nPos, nScaleX, nScaleY, nRotRad, depth + 1, bColor);
      }
    }

    // HATCH ที่อยู่ในบล็อก (dxf-parser ไม่อ่านให้)
    ctxDash = undefined;
    for (const [hi, h] of (hatches.blocks[blockName] || []).entries()) {
      const hLayer = h.layer && h.layer !== '0' ? h.layer : parentLayer;
      const { hex: hColor, num: hNum } = resolveEntityColor(
        { colorIndex: h.colorIndex, color: h.trueColor },
        layers[hLayer]?.color ?? '#ffffff',
        insertColorHex
      );
      entities.push({
        id: `${rawInsert.id || 'ins'}_blk_${depth}_hatch_${hi}`,
        type: 'HATCH',
        layer: hLayer,
        color: hColor,
        colorNumber: hNum,
        solid: h.solid,
        loops: h.loops.map((lp) => lp.map((pt) => transformPt(pt))),
        paperSpace: !!rawInsert.paperSpace,
      });
    }
  }

  // Process raw top-level entities
  const rawEntities = Array.isArray(dxfObj?.entities) ? dxfObj.entities : [];

  for (let i = 0; i < rawEntities.length; i++) {
    const raw = rawEntities[i];
    const type = (raw.type || '').toUpperCase();
    const layerName = raw.layer || '0';
    if (raw.visible === false) continue; // group code 60 = invisible
    ctxDash = dashFor(raw, 1);

    if (!layers[layerName]) {
      layers[layerName] = {
        name: layerName,
        colorNumber: 7,
        color: '#ffffff',
        visible: true,
        entityCount: 0,
      };
    }

    entityCountsByType[type] = (entityCountsByType[type] || 0) + 1;
    layers[layerName].entityCount++;

    const entityId = `ent_${i}_${type}`;
    const { hex: entityColor, num: colorNum } = resolveEntityColor(raw, layers[layerName].color);

    switch (type) {
      case 'LINE': {
        const start: Point2D = {
          x: raw.vertices?.[0]?.x ?? raw.start?.x ?? 0,
          y: raw.vertices?.[0]?.y ?? raw.start?.y ?? 0,
        };
        const end: Point2D = {
          x: raw.vertices?.[1]?.x ?? raw.end?.x ?? 0,
          y: raw.vertices?.[1]?.y ?? raw.end?.y ?? 0,
        };
        updateBounds(start.x, start.y);
        updateBounds(end.x, end.y);

        entities.push({
          id: entityId,
          type: 'LINE',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          start,
          end,
        });
        break;
      }

      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const rawVerts = raw.vertices;
        const vertices: Point2D[] = [];

        if (Array.isArray(rawVerts)) {
          for (let vi = 0; vi < rawVerts.length; vi++) {
            const pt: Point2D = { x: rawVerts[vi].x ?? 0, y: rawVerts[vi].y ?? 0 };
            vertices.push(pt);
            updateBounds(pt.x, pt.y);

            // Interpolate bulge arc if present
            if (rawVerts[vi].bulge && vi < rawVerts.length - 1) {
              const nextPt: Point2D = { x: rawVerts[vi + 1].x ?? 0, y: rawVerts[vi + 1].y ?? 0 };
              const arcPts = interpolateBulge(pt, nextPt, rawVerts[vi].bulge);
              for (const ap of arcPts) {
                vertices.push(ap);
                updateBounds(ap.x, ap.y);
              }
            }
          }
        }

        if (vertices.length > 0) {
          entities.push({
            id: entityId,
            type: 'LWPOLYLINE',
            layer: layerName,
            color: entityColor,
            colorNumber: colorNum,
            vertices,
            closed: !!raw.shape || !!raw.closed,
            lineWidth: raw.width || 0,
          });
        }
        break;
      }

      case 'CIRCLE': {
        const center: Point2D = {
          x: raw.center?.x ?? 0,
          y: raw.center?.y ?? 0,
        };
        const radius = raw.radius ?? 1;
        updateBounds(center.x - radius, center.y - radius);
        updateBounds(center.x + radius, center.y + radius);

        entities.push({
          id: entityId,
          type: 'CIRCLE',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          center,
          radius,
        });
        break;
      }

      case 'ARC': {
        const center: Point2D = {
          x: raw.center?.x ?? 0,
          y: raw.center?.y ?? 0,
        };
        const radius = raw.radius ?? 1;
        let startAngle = raw.startAngle ?? 0;
        let endAngle = raw.endAngle ?? Math.PI * 2;
        if (Math.abs(startAngle) > Math.PI * 2 || Math.abs(endAngle) > Math.PI * 2) {
          startAngle = (startAngle * Math.PI) / 180;
          endAngle = (endAngle * Math.PI) / 180;
        }

        updateBounds(center.x - radius, center.y - radius);
        updateBounds(center.x + radius, center.y + radius);

        entities.push({
          id: entityId,
          type: 'ARC',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          center,
          radius,
          startAngle,
          endAngle,
        });
        break;
      }

      case 'ELLIPSE': {
        const center: Point2D = { x: raw.center?.x ?? 0, y: raw.center?.y ?? 0 };
        const major = { x: raw.majorAxisEndPoint?.x ?? 1, y: raw.majorAxisEndPoint?.y ?? 0 };
        const rMaj = Math.hypot(major.x, major.y);
        const rMin = rMaj * (raw.axisRatio ?? 1);
        const rot = Math.atan2(major.y, major.x);

        // Convert ellipse to polygonal vertices
        const elVerts: Point2D[] = [];
        const numSteps = 32;
        const sa = raw.startAngle ?? 0;
        const ea = raw.endAngle ?? Math.PI * 2;
        for (let s = 0; s <= numSteps; s++) {
          const t = sa + ((ea - sa) * s) / numSteps;
          const ex = rMaj * Math.cos(t);
          const ey = rMin * Math.sin(t);
          const rx = ex * Math.cos(rot) - ey * Math.sin(rot);
          const ry = ex * Math.sin(rot) + ey * Math.cos(rot);
          const pt = { x: center.x + rx, y: center.y + ry };
          elVerts.push(pt);
          updateBounds(pt.x, pt.y);
        }

        entities.push({
          id: entityId,
          type: 'LWPOLYLINE',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          vertices: elVerts,
          closed: Math.abs(ea - sa) >= Math.PI * 1.99,
        });
        break;
      }

      case 'SPLINE': {
        const splinePts: Point2D[] = sampleSpline(raw);
        for (const p of splinePts) updateBounds(p.x, p.y);

        if (splinePts.length > 1) {
          entities.push({
            id: entityId,
            type: 'SPLINE',
            layer: layerName,
            color: entityColor,
            points: splinePts,
            closed: !!raw.closed,
          });
        }
        break;
      }

      case 'SOLID':
      case '3DFACE': {
        const rawPts = raw.points || raw.vertices || [];
        const solidPts: Point2D[] = [];
        for (const pt of rawPts) {
          const p = { x: pt.x ?? 0, y: pt.y ?? 0 };
          solidPts.push(p);
          updateBounds(p.x, p.y);
        }

        if (solidPts.length >= 3) {
          entities.push({
            id: entityId,
            type: 'SOLID',
            layer: layerName,
            color: entityColor,
            points: solidPts,
          });
        }
        break;
      }

      case 'LEADER':
      case 'MULTILEADER': {
        const rawVerts = raw.vertices || raw.points || [];
        const leaderPts: Point2D[] = [];
        for (const pt of rawVerts) {
          const p = { x: pt.x ?? 0, y: pt.y ?? 0 };
          leaderPts.push(p);
          updateBounds(p.x, p.y);
        }

        if (leaderPts.length > 1) {
          entities.push({
            id: entityId,
            type: 'LEADER',
            layer: layerName,
            color: entityColor,
            vertices: leaderPts,
          });
        }
        break;
      }

      case 'POINT': {
        const pt: Point2D = {
          x: raw.position?.x ?? raw.x ?? 0,
          y: raw.position?.y ?? raw.y ?? 0,
        };
        updateBounds(pt.x, pt.y);
        entities.push({
          id: entityId,
          type: 'POINT',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          position: pt,
        });
        break;
      }

      case 'ATTRIB':
      case 'ATTDEF': {
        const pos: Point2D = {
          x: raw.startPoint?.x ?? raw.position?.x ?? 0,
          y: raw.startPoint?.y ?? raw.position?.y ?? 0,
        };
        const rawText = raw.text ?? raw.tag ?? '';
        if (rawText) {
          const decodedText = decodeAutoCadEscapes(rawText);
          const height = raw.textHeight ?? raw.height ?? 2.5;
          const rotation = raw.rotation ?? 0;
          updateBounds(pos.x, pos.y);
          entities.push({
            id: entityId,
            type: 'TEXT',
            layer: layerName,
            color: entityColor,
            colorNumber: colorNum,
            position: pos,
            rawText,
            decodedText,
            height,
            rotation,
          });
        }
        break;
      }

      case 'TEXT': {
        const pos: Point2D = {
          x: raw.startPoint?.x ?? raw.position?.x ?? 0,
          y: raw.startPoint?.y ?? raw.position?.y ?? 0,
        };
        const rawText = raw.text ?? '';
        const decodedText = decodeAutoCadEscapes(rawText);
        const height = raw.textHeight ?? raw.height ?? 2.5;
        const rotation = raw.rotation ?? 0;

        updateBounds(pos.x, pos.y);
        updateBounds(pos.x + height * Math.max(decodedText.length * 0.7, 1), pos.y + height);

        entities.push({
          id: entityId,
          type: 'TEXT',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          position: pos,
          rawText,
          decodedText,
          height,
          rotation,
          horizontalAlignment: raw.halign,
          verticalAlignment: raw.valign,
        });
        break;
      }

      case 'MTEXT': {
        const pos: Point2D = {
          x: raw.position?.x ?? 0,
          y: raw.position?.y ?? 0,
        };
        const rawText = raw.string ?? raw.text ?? '';
        const { cleanedText, lines, extractedColor } = parseAndCleanMText(rawText);
        const height = raw.height ?? 2.5;
        const rotation = raw.rotation ?? 0;
        const width = raw.width;

        updateBounds(pos.x, pos.y);
        const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);
        updateBounds(pos.x + height * Math.max(maxLineLen * 0.7, 1), pos.y - height * lines.length);

        entities.push({
          id: entityId,
          type: 'MTEXT',
          layer: layerName,
          color: colorNum === 256 && extractedColor ? extractedColor : entityColor,
          colorNumber: colorNum,
          position: pos,
          rawText,
          decodedText: cleanedText,
          lines,
          height,
          rotation,
          width,
          attachmentPoint: raw.attachmentPoint,
        });
        break;
      }

      case 'HATCH': {
        const loops = raw.boundary || raw.boundaries || [];
        if (Array.isArray(loops)) {
          for (let li = 0; li < loops.length; li++) {
            const loop = loops[li];
            const rawV = loop.vertices || loop.points || [];
            if (Array.isArray(rawV) && rawV.length >= 2) {
              const loopVerts: Point2D[] = [];
              for (const v of rawV) {
                const p = { x: v.x ?? 0, y: v.y ?? 0 };
                loopVerts.push(p);
                updateBounds(p.x, p.y);
              }
              entities.push({
                id: `${entityId}_loop_${li}`,
                type: 'LWPOLYLINE',
                layer: layerName,
                color: entityColor,
                colorNumber: colorNum,
                vertices: loopVerts,
                closed: true,
                paperSpace: !!raw.paperSpace,
              });
            }
          }
        }
        break;
      }

      case 'DIMENSION': {
        const rawText = raw.text ?? '';
        const decodedText = decodeAutoCadEscapes(rawText);
        const mid: Point2D = {
          x: raw.middlePoint?.x ?? raw.insertionPoint?.x ?? 0,
          y: raw.middlePoint?.y ?? raw.insertionPoint?.y ?? 0,
        };
        const def: Point2D = {
          x: raw.definitionPoint?.x ?? raw.defpoint?.x ?? 0,
          y: raw.definitionPoint?.y ?? raw.defpoint?.y ?? 0,
        };
        updateBounds(mid.x, mid.y);

        // If the dimension has an associated block (AutoCAD generates *D... blocks for dimension graphics)
        const dimBlockName = (raw.block || raw.anonymousBlock || '').toUpperCase();
        if (dimBlockName && blocksMap[dimBlockName]) {
          expandBlockEntities(
            { ...raw, name: dimBlockName, id: `${entityId}_dim` },
            layerName,
            { x: 0, y: 0 },
            1,
            1,
            0,
            0,
            entityColor
          );
        }

        entities.push({
          id: entityId,
          type: 'DIMENSION',
          layer: layerName,
          color: entityColor,
          colorNumber: colorNum,
          middlePoint: mid,
          definitionPoint: def,
          rawText,
          decodedText,
          paperSpace: !!raw.paperSpace,
        });
        break;
      }

      case 'INSERT': {
        // Expand block entities with full geometry support
        const insertPos: Point2D = {
          x: raw.position?.x ?? 0,
          y: raw.position?.y ?? 0,
        };
        const scaleX = raw.xScale ?? raw.xscale ?? 1;
        const scaleY = raw.yScale ?? raw.yscale ?? 1;
        const rotDeg = raw.rotation ?? 0;
        const rotRad = (rotDeg * Math.PI) / 180;

        expandBlockEntities(raw, layerName, insertPos, scaleX, scaleY, rotRad, 0, entityColor);
        break;
      }

      default:
        break;
    }
  }

  // HATCH ระดับบนสุด
  ctxDash = undefined;
  hatches.model.forEach((h: RawHatch, hi: number) => {
    if (!layers[h.layer]) {
      layers[h.layer] = { name: h.layer, colorNumber: 7, color: '#ffffff', visible: true, entityCount: 0 };
    }
    layers[h.layer].entityCount++;
    entityCountsByType['HATCH'] = (entityCountsByType['HATCH'] || 0) + 1;
    const { hex, num } = resolveEntityColor({ colorIndex: h.colorIndex, color: h.trueColor }, layers[h.layer].color);
    entities.push({
      id: `ent_hatch_${hi}`,
      type: 'HATCH',
      layer: h.layer,
      color: hex,
      colorNumber: num,
      solid: h.solid,
      loops: h.loops,
    });
  });
  // วาดพื้นทึบก่อน เพื่อให้เส้นและข้อความอยู่ด้านบน (sort คงลำดับเดิมของที่เหลือ)
  entities.sort((a, b) => (a.type === 'HATCH' ? 0 : 1) - (b.type === 'HATCH' ? 0 : 1));

  // Count Model Space vs Paper Space entities
  let modelSpaceCount = 0;
  let paperSpaceCount = 0;
  for (const ent of entities) {
    if (ent.paperSpace) paperSpaceCount++;
    else modelSpaceCount++;
  }

  // Collect points for robust outlier-resilient bounding box calculation
  const pts: Point2D[] = [];
  const targetEntities = modelSpaceCount > 0 ? entities.filter((e) => !e.paperSpace) : entities;

  for (const ent of targetEntities) {
    if (ent.type === 'LINE') {
      pts.push(ent.start, ent.end);
    } else if (ent.type === 'LWPOLYLINE') {
      for (const v of ent.vertices) pts.push(v);
    } else if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
      pts.push(
        { x: ent.center.x - ent.radius, y: ent.center.y - ent.radius },
        { x: ent.center.x + ent.radius, y: ent.center.y + ent.radius }
      );
    } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      pts.push(ent.position);
    } else if (ent.type === 'SOLID') {
      for (const p of ent.points) pts.push(p);
    } else if (ent.type === 'ELLIPSE') {
      pts.push(
        { x: ent.center.x - ent.majorRadius, y: ent.center.y - ent.minorRadius },
        { x: ent.center.x + ent.majorRadius, y: ent.center.y + ent.minorRadius }
      );
    }
  }

  let fullMinX = Infinity;
  let fullMinY = Infinity;
  let fullMaxX = -Infinity;
  let fullMaxY = -Infinity;

  for (const p of pts) {
    if (isFinite(p.x) && isFinite(p.y)) {
      if (p.x < fullMinX) fullMinX = p.x;
      if (p.x > fullMaxX) fullMaxX = p.x;
      if (p.y < fullMinY) fullMinY = p.y;
      if (p.y > fullMaxY) fullMaxY = p.y;
    }
  }

  if (!isFinite(fullMinX) || !isFinite(fullMinY) || !isFinite(fullMaxX) || !isFinite(fullMaxY)) {
    fullMinX = minX < Infinity ? minX : 0;
    fullMinY = minY < Infinity ? minY : 0;
    fullMaxX = maxX > -Infinity ? maxX : 100;
    fullMaxY = maxY > -Infinity ? maxY : 100;
  }

  const fullW = Math.max(fullMaxX - fullMinX, 1);
  const fullH = Math.max(fullMaxY - fullMinY, 1);
  const fullBounds: BoundingBox = {
    minX: fullMinX,
    minY: fullMinY,
    maxX: fullMaxX,
    maxY: fullMaxY,
    width: fullW,
    height: fullH,
    centerX: fullMinX + fullW / 2,
    centerY: fullMinY + fullH / 2,
  };

  let contentBounds: BoundingBox = fullBounds;

  // Filter extreme coordinate outliers (e.g. titleblock origin at 0,0 vs UTM project coordinates)
  if (pts.length >= 10) {
    const validPts = pts.filter((p) => isFinite(p.x) && isFinite(p.y));
    const sortedX = validPts.map((p) => p.x).sort((a, b) => a - b);
    const sortedY = validPts.map((p) => p.y).sort((a, b) => a - b);

    const p01X = sortedX[Math.floor(sortedX.length * 0.015)];
    const p99X = sortedX[Math.ceil(sortedX.length * 0.985) - 1];
    const p01Y = sortedY[Math.floor(sortedY.length * 0.015)];
    const p99Y = sortedY[Math.ceil(sortedY.length * 0.985) - 1];

    const pW = Math.max(p99X - p01X, 1);
    const pH = Math.max(p99Y - p01Y, 1);

    if (fullW > pW * 2.2 || fullH > pH * 2.2) {
      const padX = Math.max(pW * 0.05, 0.5);
      const padY = Math.max(pH * 0.05, 0.5);
      const cMinX = p01X - padX;
      const cMaxX = p99X + padX;
      const cMinY = p01Y - padY;
      const cMaxY = p99Y + padY;
      const cW = cMaxX - cMinX;
      const cH = cMaxY - cMinY;
      contentBounds = {
        minX: cMinX,
        minY: cMinY,
        maxX: cMaxX,
        maxY: cMaxY,
        width: cW,
        height: cH,
        centerX: cMinX + cW / 2,
        centerY: cMinY + cH / 2,
      };
    }
  }

  return {
    filename,
    version: dxfObj?.header?.$ACADVER || 'AutoCAD DXF',
    codepage: dxfObj?.header?.$DWGCODEPAGE || detectedCodepage,
    detectedEncoding: encodingUsed,
    layers,
    entities,
    bounds: contentBounds,
    contentBounds,
    fullBounds,
    modelSpaceCount,
    paperSpaceCount,
    headerStats: {
      insUnits: dxfObj?.header?.$INSUNITS ? String(dxfObj.header.$INSUNITS) : 'Meters',
      extMin: { x: minX, y: minY },
      extMax: { x: maxX, y: maxY },
      entityCountsByType,
    },
  };
}
