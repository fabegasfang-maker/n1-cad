/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { CadEntity, ParsedCadModel, ThaiFontFamily, ThemeMode, CadSpaceFilter } from '../types/cad';
import { getContrastedCadColor } from '../utils/cadColors';

interface CadSvgRendererProps {
  model: ParsedCadModel;
  theme: ThemeMode;
  fontFamily: ThaiFontFamily;
  selectedEntity: CadEntity | null;
  onSelectEntity: (entity: CadEntity | null) => void;
  showGrid: boolean;
  textScaleMultiplier: number;
  forceSolidLines?: boolean;
  lineWeightMultiplier?: number;
}

export const CadSvgRenderer: React.FC<CadSvgRendererProps> = ({
  model,
  theme,
  fontFamily,
  selectedEntity,
  onSelectEntity,
  showGrid,
  textScaleMultiplier,
  forceSolidLines = false,
  lineWeightMultiplier = 1.0,
}) => {
  const [useFullBounds, setUseFullBounds] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState<CadSpaceFilter>('all');

  const bounds = (useFullBounds && model.fullBounds) ? model.fullBounds : (model.contentBounds || model.bounds);

  // ViewBox: padding around bounding box
  const paddingX = Math.max(bounds.width * 0.05, 1);
  const paddingY = Math.max(bounds.height * 0.05, 1);
  const vbMinX = bounds.minX - paddingX;
  const vbMinY = bounds.minY - paddingY;
  const vbWidth = bounds.width + paddingX * 2;
  const vbHeight = bounds.height + paddingY * 2;


  // Theme styling
  const themeStyles = useMemo(() => {
    if (theme === 'blueprint') {
      return {
        bg: '#0a2342',
        defaultStroke: '#e0f2fe',
        gridMajor: 'rgba(56, 189, 248, 0.18)',
        gridMinor: 'rgba(56, 189, 248, 0.08)',
      };
    }
    if (theme === 'light') {
      return {
        bg: '#ffffff',
        defaultStroke: '#0f172a',
        gridMajor: 'rgba(0, 0, 0, 0.08)',
        gridMinor: 'rgba(0, 0, 0, 0.03)',
      };
    }
    return {
      bg: '#0f141c',
      defaultStroke: '#f8fafc',
      gridMajor: 'rgba(255, 255, 255, 0.08)',
      gridMinor: 'rgba(255, 255, 255, 0.03)',
    };
  }, [theme]);

  // Notice: In CAD, Y is UP. In SVG, Y is DOWN.
  // We can flip the coordinate system using transform="scale(1, -1)" or map Y = (bounds.minY + bounds.maxY) - y.
  // Using transform="translate(0, ${vbMinY + vbHeight}) scale(1, -1) translate(0, -${vbMinY})" or mapping Y coordinates directly:
  // Mapping Y directly: svgY = (vbMinY + vbHeight) - (y - vbMinY) = 2*vbMinY + vbHeight - y
  // This makes SVG text upright when we do `<text transform="scale(1, -1)">` or direct math.
  // Let's do CAD math directly:
  const flipY = (cadY: number) => vbMinY + vbHeight - (cadY - vbMinY);

  return (
    <div className="relative w-full h-full overflow-auto bg-neutral-950 flex items-center justify-center p-4">
      <svg
        id="cad-vector-svg"
        viewBox={`${vbMinX} ${vbMinY} ${vbWidth} ${vbHeight}`}
        className="w-full h-full max-h-full transition-colors select-text"
        style={{
          backgroundColor: themeStyles.bg,
          fontFamily: `"${fontFamily}", "Sarabun", sans-serif`,
        }}
      >
        <defs>
          <pattern
            id="cad-grid-pattern"
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke={themeStyles.gridMinor}
              strokeWidth="0.05"
            />
          </pattern>
        </defs>

        {showGrid && (
          <rect
            x={vbMinX}
            y={vbMinY}
            width={vbWidth}
            height={vbHeight}
            fill="url(#cad-grid-pattern)"
          />
        )}

        {/* CAD Entities */}
        <g id="cad-entities">
          {model.entities.map((ent) => {
            // Space filtering
            if (spaceFilter === 'model' && ent.paperSpace) return null;
            if (spaceFilter === 'paper' && !ent.paperSpace) return null;

            const layer = model.layers[ent.layer];
            if (layer && !layer.visible) return null;

            const isSelected = selectedEntity?.id === ent.id;
            const rawColor = ent.color || layer?.color || themeStyles.defaultStroke;
            const strokeColor = getContrastedCadColor(rawColor, theme, themeStyles.defaultStroke);

            const stroke = isSelected ? '#f59e0b' : strokeColor;
            const strokeWidth = isSelected ? 3 : 1.25;

            switch (ent.type) {
              case 'LINE': {
                const y1 = flipY(ent.start.y);
                const y2 = flipY(ent.end.y);
                return (
                  <line
                    key={ent.id}
                    x1={ent.start.x}
                    y1={y1}
                    x2={ent.end.x}
                    y2={y2}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'LWPOLYLINE':
              case 'POLYLINE': {
                if (!ent.vertices || ent.vertices.length < 2) return null;
                const pts = ent.vertices.map((v) => `${v.x},${flipY(v.y)}`).join(' ');
                return (
                  <polyline
                    key={ent.id}
                    points={pts}
                    fill={ent.closed && ent.id.includes('solid') ? stroke : 'none'}
                    stroke={stroke}
                    strokeWidth={ent.lineWidth && ent.lineWidth > 0 ? ent.lineWidth : strokeWidth}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={ent.dash && ent.dash.length ? ent.dash.map((d) => Math.max(Math.abs(d), 1e-6)).join(' ') : undefined}
                    vectorEffect={ent.lineWidth && ent.lineWidth > 0 ? undefined : 'non-scaling-stroke'}
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }


              case 'HATCH': {
                if (!ent.loops || ent.loops.length === 0) return null;
                const d = ent.loops
                  .filter((lp) => lp.length >= 3)
                  .map((lp) => 'M ' + lp.map((v) => `${v.x} ${flipY(v.y)}`).join(' L ') + ' Z')
                  .join(' ');
                return (
                  <path
                    key={ent.id}
                    d={d}
                    fill={stroke}
                    fillOpacity={ent.solid ? 1 : 0.3}
                    fillRule="evenodd"
                    stroke="none"
                  />
                );
              }

              case 'CIRCLE': {
                const cy = flipY(ent.center.y);
                return (
                  <circle
                    key={ent.id}
                    cx={ent.center.x}
                    cy={cy}
                    r={ent.radius}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'ARC': {
                const cy = flipY(ent.center.y);
                const r = ent.radius;
                const x1 = ent.center.x + r * Math.cos(ent.startAngle);
                const y1 = flipY(ent.center.y + r * Math.sin(ent.startAngle));
                const x2 = ent.center.x + r * Math.cos(ent.endAngle);
                const y2 = flipY(ent.center.y + r * Math.sin(ent.endAngle));

                let diff = ent.endAngle - ent.startAngle;
                if (diff < 0) diff += Math.PI * 2;
                const largeArcFlag = diff > Math.PI ? 1 : 0;
                const sweepFlag = 0;

                const d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArcFlag} ${sweepFlag} ${x2} ${y2}`;

                return (
                  <path
                    key={ent.id}
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'POINT': {
                const cy = flipY(ent.position.y);
                return (
                  <circle
                    key={ent.id}
                    cx={ent.position.x}
                    cy={cy}
                    r={Math.max(bounds.width * 0.002, 0.5)}
                    fill={stroke}
                    stroke="none"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'SOLID': {
                if (!ent.points || ent.points.length < 3) return null;
                const pts = ent.points.map((p) => `${p.x},${flipY(p.y)}`).join(' ');
                return (
                  <polygon
                    key={ent.id}
                    points={pts}
                    fill={stroke}
                    fillOpacity={0.35}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'SPLINE':
              case 'LEADER': {
                const ptsArr = ent.type === 'SPLINE' ? ent.points : ent.vertices;
                if (!ptsArr || ptsArr.length < 2) return null;
                const pts = ptsArr.map((p) => `${p.x},${flipY(p.y)}`).join(' ');
                return (
                  <polyline
                    key={ent.id}
                    points={pts}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => onSelectEntity(ent)}
                  />
                );
              }

              case 'DIMENSION': {
                if (!ent.middlePoint) return null;
                const cy = flipY(ent.middlePoint.y);
                const fontSize = Math.max(model.bounds.height * 0.02 * textScaleMultiplier, 0.5);
                return (
                  <text
                    key={ent.id}
                    x={ent.middlePoint.x}
                    y={cy}
                    fill={stroke}
                    fontSize={fontSize}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="cursor-pointer hover:opacity-80 transition-opacity select-text"
                    onClick={() => onSelectEntity(ent)}
                  >
                    {ent.decodedText}
                  </text>
                );
              }

              case 'TEXT': {
                const cy = flipY(ent.position.y);
                const fontSize = Math.max(ent.height * textScaleMultiplier, 0.2);
                const rot = ent.rotation ? -ent.rotation : 0;
                return (
                  <text
                    key={ent.id}
                    x={ent.position.x}
                    y={cy}
                    fill={stroke}
                    fontSize={fontSize}
                    transform={rot ? `rotate(${rot}, ${ent.position.x}, ${cy})` : undefined}
                    dominantBaseline="alphabetic"
                    className="cursor-pointer hover:opacity-80 transition-opacity select-text"
                    onClick={() => onSelectEntity(ent)}
                  >
                    {ent.decodedText}
                  </text>
                );
              }

              case 'MTEXT': {
                const cy = flipY(ent.position.y);
                const fontSize = Math.max(ent.height * textScaleMultiplier, 0.2);
                const lines = ent.lines || [ent.decodedText];
                const rot = ent.rotation ? -ent.rotation : 0;
                return (
                  <text
                    key={ent.id}
                    x={ent.position.x}
                    y={cy}
                    fill={stroke}
                    fontSize={fontSize}
                    transform={rot ? `rotate(${rot}, ${ent.position.x}, ${cy})` : undefined}
                    dominantBaseline="hanging"
                    className="cursor-pointer hover:opacity-80 transition-opacity select-text"
                    onClick={() => onSelectEntity(ent)}
                  >
                    {lines.map((ln, idx) => (
                      <tspan
                        key={idx}
                        x={ent.position.x}
                        dy={idx === 0 ? 0 : `${fontSize * 1.3}px`}
                      >
                        {ln}
                      </tspan>
                    ))}
                  </text>
                );
              }

              default:
                return null;
            }
          })}
        </g>
      </svg>

      <div className="absolute bottom-3 left-4 flex items-center gap-3 text-xs text-neutral-400 bg-neutral-900/85 backdrop-blur-sm border border-neutral-800 px-3 py-1.5 rounded pointer-events-none tabular-nums font-mono">
        <span>
          ViewBox: <strong className="text-neutral-200">{vbWidth.toFixed(1)} x {vbHeight.toFixed(1)}</strong>
        </span>
        <span className="text-neutral-600">|</span>
        <span className="text-sky-400 font-sans">SVG Vector Mode (Text Selectable)</span>
      </div>
    </div>
  );
};
