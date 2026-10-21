/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { CadEntity, ParsedCadModel, Point2D, ThaiFontFamily, ThemeMode, CadSpaceFilter } from '../types/cad';
import { getContrastedCadColor } from '../utils/cadColors';

export interface CadCanvasHandle {
  fitToView: (useFull?: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export interface CadCanvasRendererProps {
  model: ParsedCadModel;
  theme: ThemeMode;
  fontFamily: ThaiFontFamily;
  selectedEntity: CadEntity | null;
  onSelectEntity: (entity: CadEntity | null) => void;
  isMeasureMode: boolean;
  onFinishMeasurement?: (dist: number, p1: Point2D, p2: Point2D) => void;
  showGrid: boolean;
  textScaleMultiplier: number;
  onChangeTextScale?: (val: number) => void;
  forceSolidLines?: boolean;
  lineWeightMultiplier?: number;
  onChangeLineWeight?: (val: number) => void;
  onMouseMoveCadCoord?: (coord: Point2D) => void;
  onZoomChange?: (zoom: number) => void;
  spaceFilter?: CadSpaceFilter;
  onSpaceFilterChange?: (filter: CadSpaceFilter) => void;
}

export const CadCanvasRenderer = forwardRef<CadCanvasHandle, CadCanvasRendererProps>(
  (
    {
      model,
      theme,
      fontFamily,
      selectedEntity,
      onSelectEntity,
      isMeasureMode,
      onFinishMeasurement,
      showGrid,
      textScaleMultiplier = 1.0,
      onChangeTextScale,
      forceSolidLines = false,
      lineWeightMultiplier = 0.6,
      onChangeLineWeight,
      onMouseMoveCadCoord,
      onZoomChange,
      spaceFilter: controlledSpaceFilter,
    },
    ref
  ) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // View state: pan in pixels and zoom (pixels per CAD unit)
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // CAD Space filter: Model Space vs Paper Space
  const [spaceFilter, setSpaceFilter] = useState<CadSpaceFilter>('all');
  const effectiveSpaceFilter = controlledSpaceFilter ?? spaceFilter;

  // Measurement tool state
  const [measurePoint1, setMeasurePoint1] = useState<Point2D | null>(null);
  const [measureCurrentPoint, setMeasureCurrentPoint] = useState<Point2D | null>(null);

  // Mouse CAD coordinates for status bar
  const [mouseCadCoord, setMouseCadCoord] = useState<Point2D>({ x: 0, y: 0 });

  // Performance and throttling refs for ultra-smooth 60fps pan
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafIdRef = useRef<number | null>(null);
  const lastCoordThrottleRef = useRef<number>(0);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Fit drawing to view (supports contentBounds vs fullBounds)
  const fitToView = useCallback(
    (useFull = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const b = (useFull && model.fullBounds) ? model.fullBounds : (model.contentBounds || model.bounds);
      if (!b) return;

      const rect = canvas.getBoundingClientRect();
      const margin = 48; // padding in pixels
      const availW = Math.max(rect.width - margin * 2, 50);
      const availH = Math.max(rect.height - margin * 2, 50);

      const width = Math.max(b.width, 0.0001);
      const height = Math.max(b.height, 0.0001);
      const scaleX = availW / width;
      const scaleY = availH / height;
      let newZoom = Math.min(scaleX, scaleY);

      if (!isFinite(newZoom) || newZoom <= 0) {
        newZoom = 1;
      }

      const centerX = isFinite(b.centerX) ? b.centerX : 0;
      const centerY = isFinite(b.centerY) ? b.centerY : 0;

      const newPan = {
        x: rect.width / 2 - centerX * newZoom,
        y: rect.height / 2 + centerY * newZoom,
      };

      setZoom(newZoom);
      setPan(newPan);
    },
    [model]
  );

  // Coordinate conversion helpers
  const cadToScreen = useCallback(
    (cadX: number, cadY: number) => {
      return {
        x: pan.x + cadX * zoom,
        y: pan.y - cadY * zoom,
      };
    },
    [pan, zoom]
  );

  const screenToCad = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - pan.x) / zoom,
        y: (pan.y - screenY) / zoom,
      };
    },
    [pan, zoom]
  );

  const handleZoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const cadUnderCenter = screenToCad(centerX, centerY);
    const newZoom = Math.min(zoom * 1.35, 10000000);
    setPan({
      x: centerX - cadUnderCenter.x * newZoom,
      y: centerY + cadUnderCenter.y * newZoom,
    });
    setZoom(newZoom);
  }, [screenToCad, zoom]);

  const handleZoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const cadUnderCenter = screenToCad(centerX, centerY);
    const newZoom = Math.max(zoom * 0.74, 0.0000001);
    setPan({
      x: centerX - cadUnderCenter.x * newZoom,
      y: centerY + cadUnderCenter.y * newZoom,
    });
    setZoom(newZoom);
  }, [screenToCad, zoom]);

  useImperativeHandle(
    ref,
    () => ({
      fitToView,
      zoomIn: handleZoomIn,
      zoomOut: handleZoomOut,
    }),
    [fitToView, handleZoomIn, handleZoomOut]
  );

  useEffect(() => {
    onZoomChange?.(zoom);
  }, [zoom, onZoomChange]);

  // Initial fit on model change
  useEffect(() => {
    fitToView(false);
  }, [model, fitToView]);

  // Wheel zoom handler
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newZoom = Math.max(Math.min(zoom * zoomFactor, 10000000), 0.0000001);

    // Zoom centered at mouse position
    const cadUnderMouse = screenToCad(mouseX, mouseY);
    const newPan = {
      x: mouseX - cadUnderMouse.x * newZoom,
      y: mouseY + cadUnderMouse.y * newZoom,
    };

    setZoom(newZoom);
    setPan(newPan);
  };

  // Mouse down: drag or start measurement
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const cadPt = screenToCad(mouseX, mouseY);

    // If middle click or space key pressed or normal left click when not measuring
    if (e.button === 1 || (!isMeasureMode && e.button === 0)) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }

    if (isMeasureMode && e.button === 0) {
      if (!measurePoint1) {
        setMeasurePoint1(cadPt);
        setMeasureCurrentPoint(cadPt);
      } else {
        // Complete measurement
        const dx = cadPt.x - measurePoint1.x;
        const dy = cadPt.y - measurePoint1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (onFinishMeasurement) {
          onFinishMeasurement(dist, measurePoint1, cadPt);
        }
        setMeasurePoint1(null);
        setMeasureCurrentPoint(null);
      }
    }
  };

  // Mouse move: panning or hovering / updating coordinates
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const cadPt = screenToCad(mouseX, mouseY);

    // Throttle coordinate updates during mousemove to max ~15fps (every 66ms) so React App is not thrashed
    const now = performance.now();
    if (!isDragging && now - lastCoordThrottleRef.current > 66) {
      lastCoordThrottleRef.current = now;
      setMouseCadCoord(cadPt);
      onMouseMoveCadCoord?.(cadPt);
    }

    if (isDragging) {
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      panRef.current = { x: newX, y: newY };

      // Batch pan updates to display refresh rate (60Hz V-Sync) via requestAnimationFrame
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          setPan({ x: panRef.current.x, y: panRef.current.y });
          rafIdRef.current = null;
        });
      }
    }

    if (isMeasureMode && measurePoint1) {
      setMeasureCurrentPoint(cadPt);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDragging) {
      setIsDragging(false);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      setPan({ x: panRef.current.x, y: panRef.current.y });

      // Sync final mouse coordinates upon release
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const cadPt = screenToCad(mouseX, mouseY);
      setMouseCadCoord(cadPt);
      onMouseMoveCadCoord?.(cadPt);

      // If minimal drag distance, treat as click to select entity
      const dragDist = Math.hypot(e.clientX - dragStart.x - pan.x, e.clientY - dragStart.y - pan.y);
      if (dragDist < 5 && !isMeasureMode) {
        handleEntityClick(mouseX, mouseY);
      }
    }
  };

  // Click detection: find nearest entity within 15px radius
  const handleEntityClick = (screenX: number, screenY: number) => {
    let nearest: CadEntity | null = null;
    let minDistance = 15; // pixel threshold

    for (const ent of model.entities) {
      const layer = model.layers[ent.layer];
      if (layer && !layer.visible) continue;

      if (ent.type === 'LINE') {
        const s = cadToScreen(ent.start.x, ent.start.y);
        const e = cadToScreen(ent.end.x, ent.end.y);
        const d = distToSegment({ x: screenX, y: screenY }, s, e);
        if (d < minDistance) {
          minDistance = d;
          nearest = ent;
        }
      } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
        const p = cadToScreen(ent.position.x, ent.position.y);
        const d = Math.hypot(p.x - screenX, p.y - screenY);
        if (d < minDistance + 10) {
          minDistance = d;
          nearest = ent;
        }
      } else if (ent.type === 'CIRCLE') {
        const c = cadToScreen(ent.center.x, ent.center.y);
        const rScreen = ent.radius * zoom;
        const dCenter = Math.hypot(c.x - screenX, c.y - screenY);
        const dRim = Math.abs(dCenter - rScreen);
        if (dRim < minDistance) {
          minDistance = dRim;
          nearest = ent;
        }
      }
    }

    onSelectEntity(nearest);
  };

  function distToSegment(p: Point2D, v: Point2D, w: Point2D): number {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  }

  // Primary Canvas Draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background based on theme
    let bgColor = '#0f141c';
    let defaultStroke = '#f8fafc';
    let gridMajorColor = 'rgba(255, 255, 255, 0.08)';
    let gridMinorColor = 'rgba(255, 255, 255, 0.03)';

    if (theme === 'blueprint') {
      bgColor = '#0a2342';
      defaultStroke = '#e0f2fe';
      gridMajorColor = 'rgba(56, 189, 248, 0.18)';
      gridMinorColor = 'rgba(56, 189, 248, 0.08)';
    } else if (theme === 'light') {
      bgColor = '#ffffff';
      defaultStroke = '#0f172a';
      gridMajorColor = 'rgba(0, 0, 0, 0.08)';
      gridMinorColor = 'rgba(0, 0, 0, 0.03)';
    }

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, rect.width, rect.height);

    // Draw grid if enabled
    if (showGrid) {
      // Find appropriate grid step based on zoom
      const rawStep = 50 / zoom;
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      let step = mag;
      if (rawStep / mag > 5) step = mag * 5;
      else if (rawStep / mag > 2) step = mag * 2;

      const minCad = screenToCad(0, rect.height);
      const maxCad = screenToCad(rect.width, 0);

      const startX = Math.floor(minCad.x / step) * step;
      const endX = Math.ceil(maxCad.x / step) * step;
      const startY = Math.floor(minCad.y / step) * step;
      const endY = Math.ceil(maxCad.y / step) * step;

      ctx.lineWidth = 1;
      ctx.strokeStyle = gridMinorColor;
      ctx.beginPath();
      for (let gx = startX; gx <= endX; gx += step) {
        const s = cadToScreen(gx, 0);
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, rect.height);
      }
      for (let gy = startY; gy <= endY; gy += step) {
        const s = cadToScreen(0, gy);
        ctx.moveTo(0, s.y);
        ctx.lineTo(rect.width, s.y);
      }
      ctx.stroke();

      // Major axes (0,0)
      const origin = cadToScreen(0, 0);
      ctx.strokeStyle = gridMajorColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(origin.x, 0);
      ctx.lineTo(origin.x, rect.height);
      ctx.moveTo(0, origin.y);
      ctx.lineTo(rect.width, origin.y);
      ctx.stroke();
    }

    // Viewport Culling: Compute visible CAD bounds with safety margin to skip offscreen entities
    const vLeft = (0 - pan.x) / zoom;
    const vRight = (rect.width - pan.x) / zoom;
    const vBottom = (pan.y - rect.height) / zoom;
    const vTop = (pan.y - 0) / zoom;
    const cMargin = 40 / zoom;
    const cMinX = vLeft - cMargin;
    const cMaxX = vRight + cMargin;
    const cMinY = vBottom - cMargin;
    const cMaxY = vTop + cMargin;

    // Line Path Batching state: merges thousands of individual ctx.stroke() calls into shared paths
    let activeStrokeColor = '';
    let activeLineWidth = 0;
    let isBatchingLines = false;
    let lineBatchCount = 0;

    const flushLineBatch = () => {
      if (isBatchingLines) {
        ctx.stroke();
        isBatchingLines = false;
        lineBatchCount = 0;
      }
    };

    // Draw CAD Entities
    for (const ent of model.entities) {
      // Space filter (Model Space vs Paper Space)
      if (effectiveSpaceFilter === 'model' && ent.paperSpace) continue;
      if (effectiveSpaceFilter === 'paper' && !ent.paperSpace) continue;

      const layer = model.layers[ent.layer];
      if (layer && !layer.visible) continue;

      const isSelected = selectedEntity?.id === ent.id;

      // Color selection with contrast booster (no invisible black lines on dark background)
      const rawColor = ent.color || layer?.color || defaultStroke;
      const strokeColor = getContrastedCadColor(rawColor, theme, defaultStroke);

      ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
      // ความกว้างเส้น: ใช้ความกว้าง polyline จริง (หน่วย CAD × zoom) ปรับตามตัวคูณ lineWeightMultiplier
      const minLw = Math.max(1.25 * lineWeightMultiplier, 1.0);
      const baseLw = ent.lineWidth && ent.lineWidth > 0 ? Math.max(ent.lineWidth * zoom * lineWeightMultiplier, minLw) : minLw;
      ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);

      // เส้นประ/จุด: ถ้า pattern เล็ก หรือเปิด forceSolidLines ให้วาดทึบเพื่อไม่ให้เส้นขาดหาย
      if (!forceSolidLines && ent.dash && ent.dash.length > 0) {
        const px = ent.dash.map((d) => Math.max(Math.abs(d) * zoom, d === 0 ? 1 : 0.5));
        const period = px.reduce((a, b) => a + b, 0);
        ctx.setLineDash(period >= 4 ? (px.length % 2 ? [...px, ...px] : px) : []);
      } else {
        ctx.setLineDash([]);
      }

      switch (ent.type) {
        case 'LINE': {
          // Viewport Culling: skip line if completely outside screen
          if (
            (ent.start.x < cMinX && ent.end.x < cMinX) ||
            (ent.start.x > cMaxX && ent.end.x > cMaxX) ||
            (ent.start.y < cMinY && ent.end.y < cMinY) ||
            (ent.start.y > cMaxY && ent.end.y > cMaxY)
          ) {
            break;
          }

          const s = cadToScreen(ent.start.x, ent.start.y);
          const e = cadToScreen(ent.end.x, ent.end.y);

          // LOD during pan: skip sub-pixel lines (< 1px) to keep 60fps pan smooth
          if (isDragging && Math.abs(s.x - e.x) < 1 && Math.abs(s.y - e.y) < 1) {
            break;
          }

          // Path Batching: merge solid lines of identical color & thickness
          const isSolid = forceSolidLines || !ent.dash || ent.dash.length === 0;
          const effectiveLineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);

          if (isSolid && !isSelected) {
            if (
              !isBatchingLines ||
              activeStrokeColor !== strokeColor ||
              activeLineWidth !== effectiveLineWidth ||
              lineBatchCount >= 400
            ) {
              flushLineBatch();
              ctx.strokeStyle = strokeColor;
              ctx.lineWidth = effectiveLineWidth;
              ctx.setLineDash([]);
              ctx.beginPath();
              activeStrokeColor = strokeColor;
              activeLineWidth = effectiveLineWidth;
              isBatchingLines = true;
            }
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(e.x, e.y);
            lineBatchCount++;
          } else {
            flushLineBatch();
            ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
            ctx.lineWidth = effectiveLineWidth;
            if (!forceSolidLines && ent.dash && ent.dash.length > 0) {
              const px = ent.dash.map((d) => Math.max(Math.abs(d) * zoom, d === 0 ? 1 : 0.5));
              const period = px.reduce((a, b) => a + b, 0);
              ctx.setLineDash(period >= 4 ? (px.length % 2 ? [...px, ...px] : px) : []);
            } else {
              ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(e.x, e.y);
            ctx.stroke();
          }
          break;
        }

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          flushLineBatch();
          if (!ent.vertices || ent.vertices.length < 2) break;

          // Viewport Culling for polylines
          let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
          for (let vi = 0; vi < ent.vertices.length; vi++) {
            const vx = ent.vertices[vi].x;
            const vy = ent.vertices[vi].y;
            if (vx < pMinX) pMinX = vx;
            if (vx > pMaxX) pMaxX = vx;
            if (vy < pMinY) pMinY = vy;
            if (vy > pMaxY) pMaxY = vy;
          }
          if (pMaxX < cMinX || pMinX > cMaxX || pMaxY < cMinY || pMinY > cMaxY) {
            break;
          }

          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);
          if (!forceSolidLines && ent.dash && ent.dash.length > 0) {
            const px = ent.dash.map((d) => Math.max(Math.abs(d) * zoom, d === 0 ? 1 : 0.5));
            const period = px.reduce((a, b) => a + b, 0);
            ctx.setLineDash(period >= 4 ? (px.length % 2 ? [...px, ...px] : px) : []);
          } else {
            ctx.setLineDash([]);
          }

          ctx.beginPath();
          const first = cadToScreen(ent.vertices[0].x, ent.vertices[0].y);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < ent.vertices.length; i++) {
            const pt = cadToScreen(ent.vertices[i].x, ent.vertices[i].y);
            ctx.lineTo(pt.x, pt.y);
          }
          if (ent.closed) {
            ctx.closePath();
          }
          ctx.stroke();
          break;
        }

        case 'CIRCLE': {
          flushLineBatch();
          const r = ent.radius;
          // Viewport Culling
          if (
            ent.center.x + r < cMinX ||
            ent.center.x - r > cMaxX ||
            ent.center.y + r < cMinY ||
            ent.center.y - r > cMaxY
          ) {
            break;
          }

          const c = cadToScreen(ent.center.x, ent.center.y);
          const rPx = r * zoom;
          if (isDragging && rPx < 0.8) break;

          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(rPx, 0.5), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }

        case 'ARC': {
          flushLineBatch();
          const r = ent.radius;
          // Viewport Culling
          if (
            ent.center.x + r < cMinX ||
            ent.center.x - r > cMaxX ||
            ent.center.y + r < cMinY ||
            ent.center.y - r > cMaxY
          ) {
            break;
          }

          const c = cadToScreen(ent.center.x, ent.center.y);
          const rPx = r * zoom;
          if (isDragging && rPx < 0.8) break;

          // Calculate CCW sweep in CAD coordinates [0, 2PI]
          let sweep = ent.endAngle - ent.startAngle;
          while (sweep < 0) sweep += Math.PI * 2;
          while (sweep > Math.PI * 2) sweep -= Math.PI * 2;

          const canvasStart = -ent.startAngle;
          const canvasEnd = canvasStart - sweep;
          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(rPx, 0.5), canvasStart, canvasEnd, true);
          ctx.stroke();
          break;
        }

        case 'POINT': {
          flushLineBatch();
          if (
            ent.position.x < cMinX ||
            ent.position.x > cMaxX ||
            ent.position.y < cMinY ||
            ent.position.y > cMaxY
          ) {
            break;
          }
          const p = cadToScreen(ent.position.x, ent.position.y);
          ctx.fillStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(minLw * 1.8, 3), 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        case 'ELLIPSE': {
          flushLineBatch();
          const c = cadToScreen(ent.center.x, ent.center.y);
          const rX = ent.majorRadius * zoom;
          const rY = ent.minorRadius * zoom;
          ctx.save();
          ctx.translate(c.x, c.y);
          if (ent.rotation) {
            ctx.rotate(-ent.rotation);
          }
          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.ellipse(0, 0, Math.max(rX, 0.5), Math.max(rY, 0.5), 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          break;
        }

        case 'SPLINE':
        case 'LEADER': {
          flushLineBatch();
          const pts = ent.type === 'SPLINE' ? ent.points : ent.vertices;
          if (!pts || pts.length < 2) break;
          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.lineWidth = isSelected ? Math.max(3.5, baseLw * 1.5) : Math.min(baseLw, 40);
          ctx.setLineDash([]);
          ctx.beginPath();
          const first = cadToScreen(pts[0].x, pts[0].y);
          ctx.moveTo(first.x, first.y);
          for (let pi = 1; pi < pts.length; pi++) {
            const pt = cadToScreen(pts[pi].x, pts[pi].y);
            ctx.lineTo(pt.x, pt.y);
          }
          if (ent.type === 'SPLINE' && ent.closed) {
            ctx.closePath();
          }
          ctx.stroke();
          break;
        }

        case 'HATCH': {
          flushLineBatch();
          if (!ent.loops || ent.loops.length === 0) break;
          // During fast dragging, skip heavy hatch fillings to maintain maximum FPS
          if (isDragging && !ent.solid) break;

          ctx.beginPath();
          for (const lp of ent.loops) {
            if (lp.length < 3) continue;
            const f = cadToScreen(lp[0].x, lp[0].y);
            ctx.moveTo(f.x, f.y);
            for (let pi = 1; pi < lp.length; pi++) {
              const pt = cadToScreen(lp[pi].x, lp[pi].y);
              ctx.lineTo(pt.x, pt.y);
            }
            ctx.closePath();
          }
          ctx.save();
          ctx.fillStyle = strokeColor;
          ctx.globalAlpha = ent.solid ? 1 : 0.3;
          ctx.fill('evenodd');
          ctx.restore();
          break;
        }

        case 'SOLID': {
          flushLineBatch();
          if (!ent.points || ent.points.length < 3) break;
          ctx.beginPath();
          const first = cadToScreen(ent.points[0].x, ent.points[0].y);
          ctx.moveTo(first.x, first.y);
          for (let pi = 1; pi < ent.points.length; pi++) {
            const pt = cadToScreen(ent.points[pi].x, ent.points[pi].y);
            ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.save();
          ctx.fillStyle = strokeColor;
          ctx.globalAlpha = 0.35;
          ctx.fill();
          ctx.restore();
          ctx.strokeStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.stroke();
          break;
        }

        case 'TEXT': {
          flushLineBatch();
          const fontHeight = ent.height * zoom * textScaleMultiplier;
          // Skip micro text during drag (< 5px) or idle (< 2.5px)
          if ((isDragging && fontHeight < 5 && !isSelected) || (fontHeight < 2.5 && !isSelected)) break;

          // Viewport Culling for text
          if (
            ent.position.x < cMinX - 150 ||
            ent.position.x > cMaxX + 50 ||
            ent.position.y < cMinY - 100 ||
            ent.position.y > cMaxY + 100
          ) {
            break;
          }

          const p = cadToScreen(ent.position.x, ent.position.y);
          ctx.save();
          ctx.font = `${Math.round(fontHeight)}px "${fontFamily}", "Sarabun", sans-serif`;
          ctx.fillStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.textBaseline = 'alphabetic';

          ctx.translate(p.x, p.y);
          if (ent.rotation) {
            ctx.rotate((-ent.rotation * Math.PI) / 180);
          }
          ctx.fillText(ent.decodedText, 0, 0);
          ctx.restore();
          break;
        }

        case 'MTEXT': {
          flushLineBatch();
          const fontHeight = ent.height * zoom * textScaleMultiplier;
          if ((isDragging && fontHeight < 5 && !isSelected) || (fontHeight < 2.5 && !isSelected)) break;

          if (
            ent.position.x < cMinX - 150 ||
            ent.position.x > cMaxX + 50 ||
            ent.position.y < cMinY - 100 ||
            ent.position.y > cMaxY + 100
          ) {
            break;
          }

          const p = cadToScreen(ent.position.x, ent.position.y);
          const lineSpacing = fontHeight * 1.35;
          ctx.save();
          ctx.font = `${Math.round(fontHeight)}px "${fontFamily}", "Sarabun", sans-serif`;
          ctx.fillStyle = isSelected ? '#f59e0b' : strokeColor;
          ctx.textBaseline = 'top';

          ctx.translate(p.x, p.y);
          if (ent.rotation) {
            ctx.rotate((-ent.rotation * Math.PI) / 180);
          }

          const lines = ent.lines || [ent.decodedText];
          for (let lIdx = 0; lIdx < lines.length; lIdx++) {
            ctx.fillText(lines[lIdx], 0, lIdx * lineSpacing);
          }
          ctx.restore();
          break;
        }

        case 'DIMENSION': {
          flushLineBatch();
          if (ent.middlePoint) {
            const p = cadToScreen(ent.middlePoint.x, ent.middlePoint.y);
            const fontHeight = Math.max(11, 2.5 * zoom * textScaleMultiplier);
            ctx.save();
            ctx.font = `${Math.round(fontHeight)}px "${fontFamily}", "Sarabun", sans-serif`;
            ctx.fillStyle = isSelected ? '#f59e0b' : strokeColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (ent.decodedText) {
              ctx.fillText(ent.decodedText, p.x, p.y);
            }
            if (ent.definitionPoint) {
              const defP = cadToScreen(ent.definitionPoint.x, ent.definitionPoint.y);
              ctx.beginPath();
              ctx.strokeStyle = strokeColor;
              ctx.setLineDash([3, 3]);
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(defP.x, defP.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            ctx.restore();
          }
          break;
        }

        default:
          break;
      }
    }

    // Flush any pending batched lines
    flushLineBatch();

    // Draw active measurement line if in measure mode
    if (isMeasureMode && measurePoint1 && measureCurrentPoint) {
      const p1 = cadToScreen(measurePoint1.x, measurePoint1.y);
      const p2 = cadToScreen(measureCurrentPoint.x, measureCurrentPoint.y);
      const dx = measureCurrentPoint.x - measurePoint1.x;
      const dy = measureCurrentPoint.y - measurePoint1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      ctx.save();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // End points
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.arc(p2.x, p2.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Measurement pill tag
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const distText = `ระยะ ${dist.toFixed(3)} ม. (ΔX: ${dx.toFixed(2)}, ΔY: ${dy.toFixed(2)})`;

      ctx.font = `12px "${fontFamily}", "Sarabun", sans-serif`;
      const textMetrics = ctx.measureText(distText);
      const textW = textMetrics.width;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(midX - textW / 2 - 8, midY - 20, textW + 16, 24);
      ctx.strokeStyle = '#f59e0b';
      ctx.setLineDash([]);
      ctx.strokeRect(midX - textW / 2 - 8, midY - 20, textW + 16, 24);

      ctx.fillStyle = '#fef08a';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(distText, midX, midY - 8);
      ctx.restore();
    }

    ctx.restore();
  }, [
    model,
    zoom,
    pan,
    theme,
    fontFamily,
    selectedEntity,
    showGrid,
    textScaleMultiplier,
    forceSolidLines,
    lineWeightMultiplier,
    effectiveSpaceFilter,
    isMeasureMode,
    measurePoint1,
    measureCurrentPoint,
    cadToScreen,
    screenToCad,
    isDragging,
  ]);

  return (
    <div className="relative w-full h-full select-none overflow-hidden cursor-crosshair">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      />

      {isMeasureMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-500/90 text-neutral-950 font-medium text-xs px-4 py-1.5 rounded shadow-lg flex items-center gap-2 pointer-events-none">
          <span>
            {measurePoint1
              ? 'คลิกจุดที่ 2 เพื่อระบุระยะทาง'
              : 'คลิกจุดที่ 1 เพื่อเริ่มวัดระยะ (CAD Units / ม.)'}
          </span>
        </div>
      )}
    </div>
  );
});

CadCanvasRenderer.displayName = 'CadCanvasRenderer';
