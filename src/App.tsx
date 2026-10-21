/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  FileCode2,
  FolderOpen,
  Eye,
  Sun,
  Moon,
  Compass,
  Download,
  Type,
  Maximize2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  HelpCircle,
  X,
  Sliders,
  Minus,
  Plus,
  ZoomIn,
  ZoomOut,
  FileSpreadsheet,
  HardDrive,
  CloudDownload,
} from 'lucide-react';
import { User } from 'firebase/auth';

import { CadCanvasRenderer, CadCanvasHandle } from './components/CadCanvasRenderer';
import {
  CadEntity,
  CadLayer,
  ParsedCadModel,
  Point2D,
  ThaiFontFamily,
  ThemeMode,
  CadSpaceFilter,
} from './types/cad';
import { parseDxfFromBuffer, parseDxfFromString } from './utils/dxfProcessor';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { GoogleDriveModal } from './components/GoogleDriveModal';
import { initAuth, googleSignIn, logout } from './services/googleDriveAuth';
import { downloadDriveFile } from './services/googleDriveApi';

const DEFAULT_DRIVE_FILE_ID = '1hetVemsG8FNfRZv9mJeDewi52j1yFoQY';

export default function App() {
  // App state
  const [model, setModel] = useState<ParsedCadModel | null>(null);
  const [rawDxfString, setRawDxfString] = useState<string>('');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [fontFamily, setFontFamily] = useState<ThaiFontFamily>('Sarabun');
  const [selectedEntity, setSelectedEntity] = useState<CadEntity | null>(null);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [textScaleMultiplier, setTextScaleMultiplier] = useState<number>(1.0);
  const [forceSolidLines, setForceSolidLines] = useState<boolean>(false);
  const [lineWeightMultiplier, setLineWeightMultiplier] = useState<number>(0.6);
  const [isConverting, setIsConverting] = useState<boolean>(false);
  const [conversionNote, setConversionNote] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);

  // Google Drive integration state
  const [driveFileId, setDriveFileId] = useState<string>(() => {
    return localStorage.getItem('cad_default_drive_file_id') || DEFAULT_DRIVE_FILE_ID;
  });
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [isLoadingDriveFile, setIsLoadingDriveFile] = useState<boolean>(false);
  const [showDriveModal, setShowDriveModal] = useState<boolean>(false);
  const [autoLoadAttempted, setAutoLoadAttempted] = useState<boolean>(false);

  // Bottom bar status & view controls
  const [mouseCadCoord, setMouseCadCoord] = useState<Point2D>({ x: 0, y: 0 });
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [spaceFilter, setSpaceFilter] = useState<CadSpaceFilter>('all');
  const canvasHandleRef = useRef<CadCanvasHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-dismiss banners
  useEffect(() => {
    if (!conversionError) return;
    const timer = setTimeout(() => {
      setConversionError(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [conversionError]);

  useEffect(() => {
    if (!conversionNote) return;
    const timer = setTimeout(() => {
      setConversionNote(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [conversionNote]);

  // Listen for Google Auth state
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setGoogleUser(user);
        setGoogleToken(token);
      },
      () => {
        setGoogleUser(null);
        setGoogleToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  // Core CAD buffer processor (handles both DWG wasm conversion & DXF direct parsing)
  const processCadBuffer = useCallback(
    async (buffer: ArrayBuffer, fileName: string, isDwg: boolean) => {
      setSelectedEntity(null);
      setConversionNote(null);
      setConversionError(null);

      if (isDwg) {
        setIsConverting(true);
        try {
          const response = await fetch(`/api/convert-dwg?filename=${encodeURIComponent(fileName)}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
            body: buffer,
          });

          let result: any = null;
          const contentType = response.headers.get('content-type') || '';

          if (contentType.includes('application/json')) {
            try {
              result = await response.json();
            } catch {
              throw new Error('ไม่สามารถแปลงผลลัพธ์จากเซิร์ฟเวอร์เป็น JSON ได้');
            }
          } else {
            if (response.status === 413) {
              throw new Error('ไฟล์ DWG มีขนาดใหญ่เกินกว่าที่ระบบรับได้ (เกิน 32MB) แนะนำให้เปิดใน AutoCAD แล้ว Save As เป็น DXF 2018');
            } else if (response.status === 502 || response.status === 503) {
              throw new Error('ระบบเซิร์ฟเวอร์กำลังรีสตาร์ท กรุณาลองอัปโหลดใหม่อีกครั้ง');
            } else if (response.status === 504) {
              throw new Error('การประมวลผลไฟล์ DWG ใช้เวลานานเกินกำหนด แนะนำให้บันทึกเป็น DXF 2018 จาก AutoCAD');
            } else {
              throw new Error(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ${response.status}) แนะนำให้เปิดด้วย DXF`);
            }
          }

          if (!response.ok || !result.success) {
            throw new Error(result.error || result.suggestion || 'ไม่สามารถแปลงไฟล์ DWG ได้');
          }

          // Decode dxf base64
          const binaryStr = atob(result.dxfBase64);
          const len = binaryStr.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          setConversionNote(
            `แปลงจาก DWG สำเร็จ (${(result.fileSize / 1024).toFixed(1)} KB, ใช้เวลา ${result.duration}ms)`
          );
          setConversionError(null);

          const parsed = parseDxfFromBuffer(bytes.buffer, undefined, result.filename);
          setModel(parsed);
          const decoder = new TextDecoder('utf-8');
          setRawDxfString(decoder.decode(bytes));
        } catch (err: any) {
          console.error('DWG conversion error:', err);
          setConversionError(
            err.message || 'เกิดข้อผิดพลาดในการแปลงไฟล์ DWG แนะนำให้บันทึกเป็น DXF 2018 จาก AutoCAD'
          );
        } finally {
          setIsConverting(false);
        }
      } else {
        // Direct DXF parsing
        try {
          const parsed = parseDxfFromBuffer(buffer, undefined, fileName);
          setModel(parsed);
          setConversionError(null);
          setConversionNote(null);
          const textDecoder = new TextDecoder('windows-874');
          try {
            setRawDxfString(textDecoder.decode(buffer));
          } catch {
            setRawDxfString('');
          }
        } catch (err: any) {
          console.error('DXF parse error:', err);
          setConversionError(`ไม่สามารถอ่านไฟล์ DXF ได้: ${err.message}`);
        }
      }
    },
    []
  );

  // Handle local file upload (.dxf or .dwg)
  async function handleFileUpload(file: File) {
    const fileName = file.name;
    const isDwg = fileName.toLowerCase().endsWith('.dwg');
    const isDxf = fileName.toLowerCase().endsWith('.dxf');

    if (!isDwg && !isDxf) {
      setConversionError('กรุณาเลือกไฟล์นามสกุล .DXF หรือ .DWG');
      return;
    }

    const buffer = await file.arrayBuffer();
    await processCadBuffer(buffer, fileName, isDwg);
  }

  // Google Drive Download & Processing
  const executeDownloadFromDrive = useCallback(
    async (fileId: string, token: string, knownFilename?: string) => {
      setIsLoadingDriveFile(true);
      setConversionError(null);
      try {
        const dl = await downloadDriveFile(fileId, token, knownFilename);
        await processCadBuffer(dl.buffer, dl.filename, dl.isDwg);
        setConversionNote(`โหลดแบบร่างจาก Google Drive สำเร็จ: ${dl.filename}`);
      } catch (err: any) {
        console.error('Drive load error:', err);
        setConversionError(err.message || 'ไม่สามารถโหลดไฟล์จาก Google Drive ได้');
        throw err;
      } finally {
        setIsLoadingDriveFile(false);
      }
    },
    [processCadBuffer]
  );

  const handleLoadFileFromDrive = useCallback(
    async (fileId: string, knownFilename?: string) => {
      let token = googleToken;
      if (!token) {
        const res = await googleSignIn();
        if (!res?.accessToken) {
          throw new Error('กรุณาเข้าสู่ระบบ Google เพื่อเข้าถึงไฟล์ในไดรฟ์');
        }
        setGoogleUser(res.user);
        setGoogleToken(res.accessToken);
        token = res.accessToken;
      }
      await executeDownloadFromDrive(fileId, token, knownFilename);
    },
    [googleToken, executeDownloadFromDrive]
  );

  const handleGoogleSignInAndLoadDefault = useCallback(async () => {
    try {
      const res = await googleSignIn();
      if (res) {
        setGoogleUser(res.user);
        setGoogleToken(res.accessToken);
        await executeDownloadFromDrive(driveFileId, res.accessToken);
      }
    } catch (err: any) {
      console.error('Google Sign-in failed:', err);
      setConversionError(err.message || 'การเข้าสู่ระบบ Google ไม่สำเร็จ');
    }
  }, [driveFileId, executeDownloadFromDrive]);

  const handleSaveDefaultFileId = useCallback((newId: string) => {
    setDriveFileId(newId);
    localStorage.setItem('cad_default_drive_file_id', newId);
  }, []);

  const handleGoogleSignOut = useCallback(async () => {
    await logout();
    setGoogleUser(null);
    setGoogleToken(null);
  }, []);

  const handleModalSignIn = useCallback(async () => {
    const res = await googleSignIn();
    if (res) {
      setGoogleUser(res.user);
      setGoogleToken(res.accessToken);
    }
  }, []);

  // Auto load default Google Drive file if user has active googleToken and no model loaded yet
  useEffect(() => {
    if (googleToken && !model && !autoLoadAttempted && driveFileId) {
      setAutoLoadAttempted(true);
      executeDownloadFromDrive(driveFileId, googleToken).catch((err) => {
        console.warn('Auto load from Google Drive failed:', err);
      });
    }
  }, [googleToken, model, autoLoadAttempted, driveFileId, executeDownloadFromDrive]);

  // Set all layers visibility
  const toggleAllLayers = useCallback((visible: boolean) => {
    setModel((prev) => {
      if (!prev) return prev;
      const updated: Record<string, CadLayer> = {};
      for (const [k, v] of Object.entries(prev.layers)) {
        updated[k] = { ...v, visible };
      }
      return {
        ...prev,
        layers: updated,
      };
    });
  }, []);

  // Extract all Thai texts & annotations from model (used for CSV report)
  const extractedTexts = useMemo(() => {
    if (!model) return [];
    const results: Array<{
      id: string;
      text: string;
      raw: string;
      layer: string;
      type: string;
      pos: Point2D;
      height: number;
    }> = [];

    for (const ent of model.entities) {
      if (ent.type === 'TEXT') {
        results.push({
          id: ent.id,
          text: ent.decodedText || ent.rawText,
          raw: ent.rawText,
          layer: ent.layer,
          type: 'TEXT',
          pos: ent.position,
          height: ent.height,
        });
      } else if (ent.type === 'MTEXT') {
        results.push({
          id: ent.id,
          text: ent.decodedText || ent.rawText,
          raw: ent.rawText,
          layer: ent.layer,
          type: 'MTEXT',
          pos: ent.position,
          height: ent.height,
        });
      }
    }
    return results;
  }, [model]);

  // Export functions
  function exportDxfFile() {
    if (!rawDxfString && !model) return;
    const blob = new Blob([rawDxfString], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = model?.filename || 'drawing.dxf';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportThaiTextReport() {
    if (!extractedTexts.length) return;
    let csv = '\uFEFFลำดับ,ประเภท,เลเยอร์,ข้อความภาษาไทย (Decoded),ข้อความดิบ CAD,ตำแหน่ง X,ตำแหน่ง Y,ขนาดความสูง\n';
    extractedTexts.forEach((item, idx) => {
      const clean = item.text.replace(/"/g, '""');
      const raw = item.raw.replace(/"/g, '""');
      csv += `${idx + 1},${item.type},"${item.layer}","${clean}","${raw}",${item.pos.x.toFixed(3)},${item.pos.y.toFixed(3)},${item.height.toFixed(2)}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model?.filename || 'cad'}_thai_text_report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Theme styling helpers
  const themeClasses = {
    dark: 'bg-slate-950 text-slate-100 border-slate-800',
    blueprint: 'bg-[#081a38] text-sky-100 border-blue-900',
    light: 'bg-slate-100 text-slate-900 border-slate-300',
  }[theme];

  const panelBg = {
    dark: 'bg-slate-900/90 border-slate-800 text-slate-200',
    blueprint: 'bg-[#0b2447]/90 border-blue-900/80 text-sky-100',
    light: 'bg-white/95 border-slate-200 text-slate-800 shadow-sm',
  }[theme];

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden ${themeClasses} font-sans`}>
      {/* Top Application Bar */}
      <header className={`h-14 border-b flex items-center justify-between px-4 z-20 shrink-0 ${panelBg}`}>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <FileCode2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base tracking-tight flex items-center gap-1.5">
                  N1 CAD Viewer
                </h1>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                  DWG/DXF + Thai Text
                </span>
              </div>
              <p className="text-[11px] opacity-60 truncate max-w-[280px]">
                {model ? `${model.filename} (${model.entities.length} วัตถุ)` : 'พร้อมเปิดไฟล์แบบร่าง'}
              </p>
            </div>
          </div>

        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* File Upload Trigger */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files?.[0]) {
                handleFileUpload(e.target.files[0]);
              }
            }}
            accept=".dxf,.dwg"
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition cursor-pointer shadow-sm shadow-blue-600/30"
          >
            <FolderOpen className="w-4 h-4" />
            <span className="hidden sm:inline">เปิดไฟล์ (DWG/DXF)</span>
          </button>

          {/* Google Drive Button */}
          <button
            onClick={() => setShowDriveModal(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer border ${
              googleUser
                ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
                : 'bg-slate-800/60 border-slate-700/80 hover:bg-slate-700 text-slate-300'
            }`}
            title="ดึงไฟล์จาก Google Drive / จัดการไฟล์เริ่มต้น"
          >
            <HardDrive className="w-4 h-4 text-blue-400" />
            <span className="hidden sm:inline">
              {googleUser ? 'Google Drive (เชื่อมแล้ว)' : 'Google Drive'}
            </span>
          </button>

          {/* Quick Show All Layers */}
          <button
            onClick={() => toggleAllLayers(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/40 border border-slate-700 hover:bg-slate-700/50 text-xs font-medium text-emerald-300 transition cursor-pointer"
            title="เปิดแสดงผลทุกเลเยอร์ในแบบทันที (แก้ปัญหาเส้นที่อยู่ในเลเยอร์ที่ถูกปิดไว้)"
          >
            <Eye className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden xl:inline">เปิดทุกเลเยอร์</span>
          </button>

          {/* Quick Force Solid Lines to fix missing lines */}
          <button
            onClick={() => setForceSolidLines(!forceSolidLines)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer border ${
              forceSolidLines
                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                : 'bg-slate-800/40 border-slate-700 hover:bg-slate-700/50 text-slate-300'
            }`}
            title="แก้เส้นขาด: บังคับให้วาดเป็นเส้นทึบต่อเนื่องทั้งหมด เพื่อไม่ให้เส้นประตกช่องว่าง"
          >
            <span className="w-3 h-0.5 bg-current rounded-full" />
            <span className="hidden lg:inline">
              {forceSolidLines ? 'เส้นทึบ (เปิด)' : 'แก้เส้นขาด'}
            </span>
          </button>

          {/* Thai Font Selector */}
          <div className="hidden xl:flex items-center gap-1 bg-slate-800/60 px-2 py-1 rounded-lg border border-slate-700/60 text-xs">
            <Type className="w-3.5 h-3.5 opacity-60" />
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value as ThaiFontFamily)}
              className="bg-transparent border-0 text-xs cursor-pointer focus:outline-none"
              title="เลือกฟอนต์แสดงผลภาษาไทยสำหรับแบบ CAD"
            >
              <option value="Sarabun" className="bg-slate-900 text-white">
                ฟอนต์ สารบรรณ (Sarabun)
              </option>
              <option value="Noto Sans Thai" className="bg-slate-900 text-white">
                ฟอนต์ Noto Sans Thai
              </option>
              <option value="Chakra Petch" className="bg-slate-900 text-white">
                ฟอนต์ Chakra Petch (โมเดิร์น)
              </option>
              <option value="Tahoma" className="bg-slate-900 text-white">
                ฟอนต์ Tahoma (คลาสสิก CAD)
              </option>
            </select>
          </div>

          {/* Theme Selector */}
          <div className="flex items-center bg-slate-800/60 p-0.5 rounded-lg border border-slate-700/60">
            <button
              onClick={() => setTheme('dark')}
              className={`p-1.5 rounded transition cursor-pointer ${
                theme === 'dark' ? 'bg-blue-600 text-white' : 'opacity-70 hover:opacity-100'
              }`}
              title="ธีมมืด (AutoCAD Classic Dark)"
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTheme('blueprint')}
              className={`p-1.5 rounded transition cursor-pointer ${
                theme === 'blueprint' ? 'bg-blue-600 text-white' : 'opacity-70 hover:opacity-100'
              }`}
              title="ธีมเขียวพิมพเขียว (Blueprint Navy)"
            >
              <Compass className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTheme('light')}
              className={`p-1.5 rounded transition cursor-pointer ${
                theme === 'light' ? 'bg-blue-600 text-white' : 'opacity-70 hover:opacity-100'
              }`}
              title="ธีมกระดาษขาว (White Paper)"
            >
              <Sun className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Export Dropdown */}
          <div className="relative group">
            <button className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-700 text-xs font-medium border border-slate-700/70 cursor-pointer">
              <Download className="w-4 h-4 text-emerald-400" />
              <span className="hidden sm:inline">ส่งออก</span>
            </button>
            <div className="absolute right-0 top-full mt-1 w-48 py-1 rounded-lg bg-slate-900 border border-slate-800 shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
              <button
                onClick={exportDxfFile}
                className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-800 flex items-center gap-2 text-slate-200 cursor-pointer"
              >
                <FileCode2 className="w-4 h-4 text-blue-400" />
                ส่งออกเป็นไฟล์ DXF
              </button>
              <button
                onClick={exportThaiTextReport}
                className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-800 flex items-center gap-2 text-slate-200 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                รายงานข้อความไทย (CSV)
              </button>
            </div>
          </div>

          {/* Help Modal Toggle */}
          <button
            onClick={() => setShowHelpModal(true)}
            className="p-1.5 rounded-lg bg-slate-800/50 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
            title="วิธีใช้งานและปุ่มลัด"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Conversion Banner or Notification */}
      {isConverting && (
        <div className="bg-blue-900/80 border-b border-blue-700 text-blue-100 px-4 py-2 text-xs flex items-center gap-2 shrink-0 animate-pulse">
          <RefreshCw className="w-4 h-4 animate-spin text-blue-300" />
          <span>กำลังแปลงไฟล์ DWG เป็น DXF ด้วย LibreDWG WebAssembly Engine... กรุณารอสักครู่</span>
        </div>
      )}
      {conversionNote && (
        <div className="bg-emerald-950/80 border-b border-emerald-800 text-emerald-200 px-4 py-1.5 text-xs flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{conversionNote}</span>
          </div>
          <button onClick={() => setConversionNote(null)} className="cursor-pointer opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {conversionError && (
        <div className="bg-rose-950/90 border-b border-rose-800 text-rose-200 px-4 py-2 text-xs flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{conversionError}</span>
          </div>
          <button onClick={() => setConversionError(null)} className="cursor-pointer opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Workspace Area: Fullscreen CAD Viewport */}
      <div className="flex-1 relative flex flex-col h-full w-full overflow-hidden bg-transparent">
        {model ? (
          <CadCanvasRenderer
            ref={canvasHandleRef}
            model={model}
            theme={theme}
            fontFamily={fontFamily}
            selectedEntity={selectedEntity}
            onSelectEntity={setSelectedEntity}
            isMeasureMode={false}
            showGrid={showGrid}
            textScaleMultiplier={textScaleMultiplier}
            onChangeTextScale={setTextScaleMultiplier}
            forceSolidLines={forceSolidLines}
            lineWeightMultiplier={lineWeightMultiplier}
            onChangeLineWeight={setLineWeightMultiplier}
            onMouseMoveCadCoord={setMouseCadCoord}
            onZoomChange={setZoomLevel}
            spaceFilter={spaceFilter}
            onSpaceFilterChange={setSpaceFilter}
          />
        ) : isLoadingDriveFile ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-pulse">
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-4 text-blue-400 shadow-inner">
              <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
            <h2 className="text-base font-semibold text-slate-200 mb-1.5">
              กำลังดาวน์โหลดแบบร่างจาก Google Drive...
            </h2>
            <p className="text-xs text-slate-400 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-slate-800 mb-3">
              File ID: {driveFileId}
            </p>
            <p className="text-xs text-slate-500 max-w-sm">
              กำลังเชื่อมต่อ Google Drive API และประมวลผลเอนทิตี CAD กรุณารอสักครู่
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-4 text-blue-400 shadow-inner">
              <HardDrive className="w-8 h-8" />
            </div>
            <h2 className="text-base font-semibold text-slate-200 mb-1.5">
              {googleUser ? 'พร้อมเปิดไฟล์แบบร่างจาก Google Drive' : 'ดึงไฟล์ DXF ใน Google Drive มาแสดงเป็นค่าเริ่มต้น'}
            </h2>
            <div className="inline-flex items-center gap-1.5 text-xs text-slate-400 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-slate-800 my-2">
              <span className="text-slate-500">File ID:</span>
              <span className="text-blue-300 font-semibold">{driveFileId}</span>
            </div>
            <p className="text-xs text-slate-400 mb-5 leading-relaxed">
              {googleUser
                ? `เชื่อมต่อบัญชี Google (${googleUser.email}) เรียบร้อยแล้ว พร้อมโหลดแบบร่างเริ่มต้น`
                : 'เชื่อมต่อบัญชี Google ของคุณ เพื่อดึงไฟล์ DXF จาก Google Drive มาเปิดบนหน้าจอ N1 CAD Viewer'}
            </p>

            <div className="flex flex-col sm:flex-row items-center gap-3 w-full justify-center">
              {googleUser ? (
                <button
                  onClick={() => handleLoadFileFromDrive(driveFileId)}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition cursor-pointer shadow-lg shadow-blue-600/30 active:scale-95"
                >
                  <HardDrive className="w-4 h-4" />
                  <span>โหลดแบบร่าง CAD จาก Google Drive</span>
                </button>
              ) : (
                <GoogleSignInButton
                  onClick={handleGoogleSignInAndLoadDefault}
                  label="เข้าสู่ระบบ Google เพื่อเปิดไฟล์นี้"
                />
              )}

              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition cursor-pointer active:scale-95"
              >
                <FolderOpen className="w-4 h-4" />
                <span>เปิดไฟล์จากในเครื่อง</span>
              </button>
            </div>

            <div className="mt-4">
              <button
                onClick={() => setShowDriveModal(true)}
                className="text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
              >
                เลือกไฟล์อื่นหรือเปลี่ยน Google Drive File ID →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Status & Control Bar - อยู่นอกผืนผ้าใบ ด้านล่าง ก่อน XY */}
      <footer className={`h-11 border-t flex items-center justify-between px-3 text-xs shrink-0 z-20 ${panelBg}`}>
        <div className="flex items-center gap-3 overflow-x-auto py-1">
          {/* ปุ่ม ขนาดอักษร */}
          <div className="flex items-center gap-1.5 bg-slate-800/80 border border-slate-700/80 px-2.5 py-1 rounded-lg shrink-0">
            <Type className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap">ขนาดอักษร:</span>
            <button
              onClick={() => setTextScaleMultiplier((prev) => Math.max(0.4, Number((prev - 0.2).toFixed(1))))}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 active:scale-95 text-white font-bold cursor-pointer transition shadow-sm"
              title="ลดขนาดตัวอักษร (-0.2)"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="text-xs font-mono font-bold text-blue-400 min-w-[34px] text-center">
              {textScaleMultiplier.toFixed(1)}x
            </span>
            <button
              onClick={() => setTextScaleMultiplier((prev) => Math.min(4.0, Number((prev + 0.2).toFixed(1))))}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 active:scale-95 text-white font-bold cursor-pointer transition shadow-sm"
              title="เพิ่มขนาดตัวอักษร (+0.2)"
            >
              <Plus className="w-3 h-3" />
            </button>
            <input
              type="range"
              min="0.4"
              max="3.5"
              step="0.1"
              value={textScaleMultiplier}
              onChange={(e) => setTextScaleMultiplier(parseFloat(e.target.value))}
              className="w-14 h-1.5 accent-blue-500 cursor-pointer hidden md:inline-block ml-1"
              title="สไลเดอร์ปรับขนาดตัวอักษร"
            />
          </div>

          {/* ปุ่ม ความหนาเส้น */}
          <div className="flex items-center gap-1.5 bg-slate-800/80 border border-slate-700/80 px-2.5 py-1 rounded-lg shrink-0">
            <Sliders className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap">ความหนาเส้น:</span>
            <button
              onClick={() => setLineWeightMultiplier((prev) => Math.max(0.2, Number((prev - 0.2).toFixed(1))))}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 active:scale-95 text-white font-bold cursor-pointer transition shadow-sm"
              title="ลดความหนาเส้น (-0.2)"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="text-xs font-mono font-bold text-emerald-400 min-w-[34px] text-center">
              {lineWeightMultiplier.toFixed(1)}x
            </span>
            <button
              onClick={() => setLineWeightMultiplier((prev) => Math.min(4.0, Number((prev + 0.2).toFixed(1))))}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 active:scale-95 text-white font-bold cursor-pointer transition shadow-sm"
              title="เพิ่มความหนาเส้น (+0.2)"
            >
              <Plus className="w-3 h-3" />
            </button>
            <input
              type="range"
              min="0.2"
              max="3.5"
              step="0.2"
              value={lineWeightMultiplier}
              onChange={(e) => setLineWeightMultiplier(parseFloat(e.target.value))}
              className="w-14 h-1.5 accent-emerald-500 cursor-pointer hidden md:inline-block ml-1"
              title="สไลเดอร์ปรับความหนาเส้น"
            />
          </div>

          {/* พิกัด XY & Zoom (อยู่หลังปุ่มขนาดอักษรและความหนาเส้น) */}
          <div className="flex items-center gap-2 bg-slate-900/60 border border-slate-800 px-2.5 py-1 rounded-lg font-mono text-[11px] text-slate-300 whitespace-nowrap shrink-0">
            <span>
              X: <strong className="text-white font-bold">{mouseCadCoord.x.toFixed(3)}</strong>
            </span>
            <span className="text-slate-600">|</span>
            <span>
              Y: <strong className="text-white font-bold">{mouseCadCoord.y.toFixed(3)}</strong>
            </span>
            <span className="text-slate-600">|</span>
            <span>
              Zoom: <strong className="text-white font-bold">{Math.round(zoomLevel * 100)}%</strong>
            </span>
          </div>
        </div>

        {/* Viewport Actions: Model/Paper Filter & Zoom/Fit buttons */}
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {model && (model.paperSpaceCount || 0) > 0 && (
            <div className="hidden sm:flex items-center bg-slate-800/80 p-0.5 rounded border border-slate-700/80 mr-1 text-[11px]">
              <button
                onClick={() => setSpaceFilter('all')}
                className={`px-2 py-0.5 rounded cursor-pointer transition ${
                  spaceFilter === 'all' ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-white'
                }`}
                title="แสดงทั้ง Model Space และ Paper Space"
              >
                ทั้งหมด
              </button>
              <button
                onClick={() => setSpaceFilter('model')}
                className={`px-2 py-0.5 rounded cursor-pointer transition ${
                  spaceFilter === 'model' ? 'bg-amber-500/20 text-amber-300 font-medium border border-amber-500/30' : 'text-slate-400 hover:text-white'
                }`}
                title="แสดงเฉพาะพื้นที่โมเดล"
              >
                โมเดล ({model.modelSpaceCount || 0})
              </button>
              <button
                onClick={() => setSpaceFilter('paper')}
                className={`px-2 py-0.5 rounded cursor-pointer transition ${
                  spaceFilter === 'paper' ? 'bg-sky-500/20 text-sky-300 font-medium border border-sky-500/30' : 'text-slate-400 hover:text-white'
                }`}
                title="แสดงเฉพาะพื้นที่กระดาษ (Layout)"
              >
                กระดาษ ({model.paperSpaceCount || 0})
              </button>
            </div>
          )}

          <button
            onClick={() => canvasHandleRef.current?.zoomIn()}
            className="p-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-200 transition cursor-pointer"
            title="ซูมเข้า (Zoom In)"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => canvasHandleRef.current?.zoomOut()}
            className="p-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-200 transition cursor-pointer"
            title="ซูมออก (Zoom Out)"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => canvasHandleRef.current?.fitToView(false)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition cursor-pointer text-xs shadow-sm"
            title="ซูมพอดีผัง CAD (Fit to View)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>พอดีผัง</span>
          </button>
        </div>
      </footer>

      {/* Help & Shortcuts Modal */}
      {showHelpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6 text-slate-200 text-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-blue-400 flex items-center gap-2">
                <HelpCircle className="w-5 h-5" /> คำแนะนำการใช้งาน N1 CAD Viewer
              </h3>
              <button
                onClick={() => setShowHelpModal(false)}
                className="p-1 rounded hover:bg-slate-800 cursor-pointer opacity-70 hover:opacity-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <h4 className="font-semibold text-amber-400 mb-1">การเลื่อนและซูมมุมมอง (Pan & Zoom)</h4>
                <ul className="list-disc list-inside space-y-0.5 text-slate-300">
                  <li><strong>เลื่อนแบบร่าง (Pan):</strong> คลิกเมาส์ซ้ายค้างไว้แล้วลาก หรือกดปุ่ม Spacebar ค้างไว้แล้วลาก</li>
                  <li><strong>ซูมเข้า-ออก (Zoom):</strong> หมุนลูกกลิ้งเมาส์ (Mouse Wheel) ไปข้างหน้า/หลัง</li>
                  <li><strong>รีเซ็ตขนาดพอดีจอ (Fit to View):</strong> ดับเบิ้ลคลิกบนผืนผ้าใบ หรือกดปุ่มไอคอนสี่เหลี่ยมขยายมุมขวาล่าง</li>
                </ul>
              </div>

              <div>
                <h4 className="font-semibold text-emerald-400 mb-1">ระบบภาษาไทยและการถอดรหัสฟอนต์</h4>
                <p className="text-slate-300 leading-relaxed">
                  รองรับการถอดรหัสตัวอักษรภาษาไทยจากทั้งรูปแบบ <strong>TIS-620 / Windows-874</strong> และ <strong>UTF-8</strong> รวมถึงรหัส Unicode Escape ของ AutoCAD เช่น <code>\U+0E01</code> โดยไม่ต้องลงฟอนต์ SHX เสริม
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-sky-400 mb-1">การแปลงไฟล์ DWG เป็น DXF</h4>
                <p className="text-slate-300 leading-relaxed">
                  ระบบมาพร้อมเครื่องมือ <strong>LibreDWG WebAssembly</strong> สามารถเปิดไฟล์ <code>.dwg</code> ได้โดยตรง ระบบจะแปลงและเรนเดอร์ให้โดยอัตโนมัติ
                </p>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 flex justify-end">
              <button
                onClick={() => setShowHelpModal(false)}
                className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium cursor-pointer"
              >
                เข้าใจแล้ว
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Google Drive Integration Modal */}
      <GoogleDriveModal
        isOpen={showDriveModal}
        onClose={() => setShowDriveModal(false)}
        user={googleUser}
        accessToken={googleToken}
        onSignIn={handleModalSignIn}
        onSignOut={handleGoogleSignOut}
        currentDefaultFileId={driveFileId}
        onSaveDefaultFileId={handleSaveDefaultFileId}
        onLoadFileFromDrive={handleLoadFileFromDrive}
        isLoadingFile={isLoadingDriveFile}
      />
    </div>
  );
}
