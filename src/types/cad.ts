/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface CadLayer {
  name: string;
  color: string;
  colorNumber?: number;
  visible: boolean;
  entityCount: number;
  lineType?: string;
}

export interface BaseCadEntity {
  id: string;
  type: string;
  layer: string;
  color?: string;
  colorNumber?: number;
  lineType?: string;
  lineWidth?: number; // ความกว้างเส้นเป็นหน่วย CAD (เช่น polyline width)
  dash?: number[]; // pattern เส้นประเป็นหน่วย CAD (ลบ = ช่องว่าง)
  paperSpace?: boolean;
}

export interface LineCadEntity extends BaseCadEntity {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
}

export interface LwPolylineCadEntity extends BaseCadEntity {
  type: 'LWPOLYLINE' | 'POLYLINE';
  vertices: Point2D[];
  closed: boolean;
  elevation?: number;
}

export interface CircleCadEntity extends BaseCadEntity {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
}

export interface ArcCadEntity extends BaseCadEntity {
  type: 'ARC';
  center: Point2D;
  radius: number;
  startAngle: number; // in radians
  endAngle: number;   // in radians
}

export interface EllipseCadEntity extends BaseCadEntity {
  type: 'ELLIPSE';
  center: Point2D;
  majorRadius: number;
  minorRadius: number;
  majorAxisEndPoint?: Point2D;
  axisRatio?: number;
  rotation?: number;
  startAngle: number;
  endAngle: number;
}

export interface TextCadEntity extends BaseCadEntity {
  type: 'TEXT';
  position: Point2D;
  rawText: string;
  decodedText: string;
  height: number;
  rotation?: number; // in degrees
  horizontalAlignment?: number;
  verticalAlignment?: number;
  style?: string;
}

export interface MTextCadEntity extends BaseCadEntity {
  type: 'MTEXT';
  position: Point2D;
  rawText: string;
  decodedText: string;
  height: number;
  rotation?: number; // in degrees
  width?: number;
  attachmentPoint?: number;
  drawingDirection?: number;
  lines: string[];
}

export interface DimensionCadEntity extends BaseCadEntity {
  type: 'DIMENSION';
  definitionPoint?: Point2D;
  middlePoint?: Point2D;
  insertionPoint?: Point2D;
  rawText?: string;
  decodedText?: string;
  dimensionType?: number;
}

export interface SolidCadEntity extends BaseCadEntity {
  type: 'SOLID';
  points: Point2D[];
}

export interface SplineCadEntity extends BaseCadEntity {
  type: 'SPLINE';
  points: Point2D[];
  closed?: boolean;
}

export interface LeaderCadEntity extends BaseCadEntity {
  type: 'LEADER';
  vertices: Point2D[];
}

export interface HatchCadEntity extends BaseCadEntity {
  type: 'HATCH';
  loops: Point2D[][];
  solid: boolean;
}

export interface PointCadEntity extends BaseCadEntity {
  type: 'POINT';
  position: Point2D;
}

export type CadEntity =
  | HatchCadEntity
  | LineCadEntity
  | LwPolylineCadEntity
  | CircleCadEntity
  | ArcCadEntity
  | EllipseCadEntity
  | TextCadEntity
  | MTextCadEntity
  | DimensionCadEntity
  | SolidCadEntity
  | SplineCadEntity
  | LeaderCadEntity
  | PointCadEntity;

export interface ParsedCadModel {
  filename: string;
  version?: string;
  codepage?: string;
  detectedEncoding: string;
  layers: Record<string, CadLayer>;
  entities: CadEntity[];
  bounds: BoundingBox;
  contentBounds?: BoundingBox;
  fullBounds?: BoundingBox;
  modelSpaceCount?: number;
  paperSpaceCount?: number;
  headerStats: {
    insUnits?: string;
    extMin?: Point2D;
    extMax?: Point2D;
    entityCountsByType: Record<string, number>;
  };
}

export type CadSpaceFilter = 'all' | 'model' | 'paper';
export type ThemeMode = 'dark' | 'blueprint' | 'light';
export type RenderMode = 'canvas' | 'svg';
export type ThaiFontFamily = 'Sarabun' | 'Noto Sans Thai' | 'Chakra Petch' | 'Tahoma';

