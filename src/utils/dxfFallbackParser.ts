/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoundingBox,
  CadEntity,
  CadLayer,
  LineCadEntity,
  LwPolylineCadEntity,
  CircleCadEntity,
  ArcCadEntity,
  TextCadEntity,
  MTextCadEntity,
  ParsedCadModel,
  Point2D,
} from '../types/cad';
import { aciToHex } from './aciPalette';
import { getCadColor } from './cadColors';
import { decodeAutoCadEscapes, parseAndCleanMText } from './thaiDxfDecoder';

interface DxfPair {
  code: number;
  value: string;
}

/**
 * Tokenize DXF string into group code / value pairs
 */
function tokenizeDxf(dxfString: string): DxfPair[] {
  const lines = dxfString.split(/\r?\n/);
  const pairs: DxfPair[] = [];
  for (let i = 0; i < lines.length - 1; i += 2) {
    const rawCode = lines[i].trim();
    if (rawCode === '') continue;
    const code = parseInt(rawCode, 10);
    if (isNaN(code)) continue;
    const value = lines[i + 1]?.trim() ?? '';
    pairs.push({ code, value });
  }
  return pairs;
}

/**
 * Resilient fallback scanner for DXF files when standard parser fails
 */
export function parseDxfWithFallback(
  dxfString: string,
  filename = 'drawing.dxf',
  detectedCodepage = 'Auto-detected',
  encodingUsed = 'utf-8'
): ParsedCadModel {
  const pairs = tokenizeDxf(dxfString);
  const layers: Record<string, CadLayer> = {
    '0': {
      name: '0',
      color: '#ffffff',
      colorNumber: 7,
      visible: true,
      entityCount: 0,
      lineType: 'Continuous',
    },
  };
  const entities: CadEntity[] = [];
  const entityCountsByType: Record<string, number> = {};

  let inEntities = false;
  let currentEntity: { type: string; props: Record<number, string[]>; id: string } | null = null;
  let entityCounter = 0;

  function commitEntity() {
    if (!currentEntity) return;
    const type = currentEntity.type.toUpperCase();
    const props = currentEntity.props;
    const layer = props[8]?.[0] || '0';
    const colorNum = props[62]?.[0] ? Math.abs(parseInt(props[62][0], 10)) : 7;
    const color = aciToHex(colorNum) ?? getCadColor(colorNum, undefined, true);
    const id = currentEntity.id;

    if (!layers[layer]) {
      layers[layer] = {
        name: layer,
        color,
        colorNumber: colorNum,
        visible: true,
        entityCount: 0,
        lineType: props[6]?.[0] || 'Continuous',
      };
    }
    layers[layer].entityCount++;
    entityCountsByType[type] = (entityCountsByType[type] || 0) + 1;

    switch (type) {
      case 'LINE': {
        const x1 = parseFloat(props[10]?.[0] || '0');
        const y1 = parseFloat(props[20]?.[0] || '0');
        const x2 = parseFloat(props[11]?.[0] || '0');
        const y2 = parseFloat(props[21]?.[0] || '0');
        const ent: LineCadEntity = {
          id,
          type: 'LINE',
          layer,
          color,
          colorNumber: colorNum,
          start: { x: x1, y: y1 },
          end: { x: x2, y: y2 },
        };
        entities.push(ent);
        break;
      }

      case 'LWPOLYLINE': {
        const xs = (props[10] || []).map((v) => parseFloat(v));
        const ys = (props[20] || []).map((v) => parseFloat(v));
        const vertices: Point2D[] = [];
        const count = Math.min(xs.length, ys.length);
        for (let i = 0; i < count; i++) {
          vertices.push({ x: xs[i], y: ys[i] });
        }
        const flag = parseInt(props[70]?.[0] || '0', 10);
        const closed = (flag & 1) === 1;
        if (vertices.length > 0) {
          const ent: LwPolylineCadEntity = {
            id,
            type: 'LWPOLYLINE',
            layer,
            color,
            colorNumber: colorNum,
            vertices,
            closed,
          };
          entities.push(ent);
        }
        break;
      }

      case 'CIRCLE': {
        const cx = parseFloat(props[10]?.[0] || '0');
        const cy = parseFloat(props[20]?.[0] || '0');
        const r = parseFloat(props[40]?.[0] || '1');
        const ent: CircleCadEntity = {
          id,
          type: 'CIRCLE',
          layer,
          color,
          colorNumber: colorNum,
          center: { x: cx, y: cy },
          radius: r,
        };
        entities.push(ent);
        break;
      }

      case 'ARC': {
        const cx = parseFloat(props[10]?.[0] || '0');
        const cy = parseFloat(props[20]?.[0] || '0');
        const r = parseFloat(props[40]?.[0] || '1');
        const startDeg = parseFloat(props[50]?.[0] || '0');
        const endDeg = parseFloat(props[51]?.[0] || '360');
        const ent: ArcCadEntity = {
          id,
          type: 'ARC',
          layer,
          color,
          colorNumber: colorNum,
          center: { x: cx, y: cy },
          radius: r,
          startAngle: (startDeg * Math.PI) / 180,
          endAngle: (endDeg * Math.PI) / 180,
        };
        entities.push(ent);
        break;
      }

      case 'TEXT': {
        const px = parseFloat(props[10]?.[0] || '0');
        const py = parseFloat(props[20]?.[0] || '0');
        const rawText = props[1]?.[0] || '';
        const decodedText = decodeAutoCadEscapes(rawText);
        const height = parseFloat(props[40]?.[0] || '2.5');
        const rotation = parseFloat(props[50]?.[0] || '0');
        const ent: TextCadEntity = {
          id,
          type: 'TEXT',
          layer,
          color,
          colorNumber: colorNum,
          position: { x: px, y: py },
          rawText,
          decodedText,
          height,
          rotation,
        };
        entities.push(ent);
        break;
      }

      case 'MTEXT': {
        const px = parseFloat(props[10]?.[0] || '0');
        const py = parseFloat(props[20]?.[0] || '0');
        const textParts = [...(props[3] || []), ...(props[1] || [])];
        const rawText = textParts.join('');
        const decoded = parseAndCleanMText(rawText);
        const height = parseFloat(props[40]?.[0] || '2.5');
        const rotation = parseFloat(props[50]?.[0] || '0');
        const ent: MTextCadEntity = {
          id,
          type: 'MTEXT',
          layer,
          color,
          colorNumber: colorNum,
          position: { x: px, y: py },
          rawText,
          decodedText: decoded.cleanedText,
          height,
          rotation,
          lines: decoded.lines,
        };
        entities.push(ent);
        break;
      }
    }
  }

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];

    if (code === 0 && value === 'SECTION') {
      const next = pairs[i + 1];
      if (next && next.code === 2 && next.value === 'ENTITIES') {
        inEntities = true;
      }
      continue;
    }

    if (code === 0 && value === 'ENDSEC') {
      if (inEntities) {
        commitEntity();
        inEntities = false;
        break;
      }
    }

    if (inEntities) {
      if (code === 0) {
        commitEntity();
        currentEntity = {
          type: value,
          props: {},
          id: `fb_ent_${++entityCounter}`,
        };
      } else if (currentEntity) {
        if (!currentEntity.props[code]) {
          currentEntity.props[code] = [];
        }
        currentEntity.props[code].push(value);
      }
    }
  }

  // Calculate bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function expandBounds(x: number, y: number) {
    if (isNaN(x) || isNaN(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  for (const ent of entities) {
    switch (ent.type) {
      case 'LINE':
        expandBounds(ent.start.x, ent.start.y);
        expandBounds(ent.end.x, ent.end.y);
        break;
      case 'LWPOLYLINE':
        for (const v of ent.vertices) expandBounds(v.x, v.y);
        break;
      case 'CIRCLE':
      case 'ARC':
        expandBounds(ent.center.x - ent.radius, ent.center.y - ent.radius);
        expandBounds(ent.center.x + ent.radius, ent.center.y + ent.radius);
        break;
      case 'TEXT':
      case 'MTEXT':
        expandBounds(ent.position.x, ent.position.y);
        break;
    }
  }

  if (minX === Infinity) {
    minX = -10;
    minY = -10;
    maxX = 10;
    maxY = 10;
  }

  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const bounds: BoundingBox = {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };

  return {
    filename,
    version: 'DXF (Fallback Scanner)',
    codepage: detectedCodepage,
    detectedEncoding: encodingUsed,
    layers,
    entities,
    bounds,
    contentBounds: bounds,
    fullBounds: bounds,
    modelSpaceCount: entities.length,
    paperSpaceCount: 0,
    headerStats: {
      insUnits: 'Meters',
      extMin: { x: minX, y: minY },
      extMax: { x: maxX, y: maxY },
      entityCountsByType,
    },
  };
}
