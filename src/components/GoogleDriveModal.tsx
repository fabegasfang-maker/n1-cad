import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import {
  X,
  HardDrive,
  FileCode2,
  RefreshCw,
  LogOut,
  ExternalLink,
  Check,
  AlertCircle,
  FileCheck,
  Clock,
  Sparkles,
} from 'lucide-react';
import { GoogleSignInButton } from './GoogleSignInButton';
import {
  extractDriveFileId,
  listDriveCadFiles,
  GoogleDriveFileMeta,
} from '../services/googleDriveApi';

interface GoogleDriveModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  accessToken: string | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  currentDefaultFileId: string;
  onSaveDefaultFileId: (fileId: string) => void;
  onLoadFileFromDrive: (fileId: string, filename?: string) => Promise<void>;
  isLoadingFile: boolean;
}

export const GoogleDriveModal: React.FC<GoogleDriveModalProps> = ({
  isOpen,
  onClose,
  user,
  accessToken,
  onSignIn,
  onSignOut,
  currentDefaultFileId,
  onSaveDefaultFileId,
  onLoadFileFromDrive,
  isLoadingFile,
}) => {
  const [fileInput, setFileInput] = useState(currentDefaultFileId);
  const [setAsDefault, setSetAsDefault] = useState(true);
  const [recentFiles, setRecentFiles] = useState<GoogleDriveFileMeta[]>([]);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    setFileInput(currentDefaultFileId);
  }, [currentDefaultFileId]);

  // Load recent CAD files when accessToken is available and modal is open
  useEffect(() => {
    if (isOpen && accessToken) {
      loadRecentFiles(accessToken);
    }
  }, [isOpen, accessToken]);

  const loadRecentFiles = async (token: string) => {
    setIsLoadingRecent(true);
    setErrorMessage(null);
    try {
      const files = await listDriveCadFiles(token);
      setRecentFiles(files);
    } catch (err: any) {
      console.warn('Failed to list files:', err);
    } finally {
      setIsLoadingRecent(false);
    }
  };

  if (!isOpen) return null;

  const handleLoadClicked = async (idToLoad?: string, nameToLoad?: string) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const targetId = extractDriveFileId(idToLoad || fileInput);
    if (!targetId) {
      setErrorMessage('กรุณาระบุ Google Drive File ID หรือแชร์ลิงก์');
      return;
    }

    if (setAsDefault) {
      onSaveDefaultFileId(targetId);
    }

    try {
      await onLoadFileFromDrive(targetId, nameToLoad);
      setSuccessMessage('โหลดไฟล์แบบร่างจาก Google Drive เรียบร้อยแล้ว!');
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setErrorMessage(err.message || 'ไม่สามารถโหลดไฟล์จาก Google Drive ได้');
    }
  };

  const formatFileSize = (bytesStr?: string) => {
    if (!bytesStr) return '';
    const bytes = parseInt(bytesStr, 10);
    if (isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="relative w-full max-w-xl bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-neutral-100 flex items-center gap-2">
                ดึงไฟล์ DXF จาก Google Drive
              </h3>
              <p className="text-xs text-neutral-400">
                โหลดไฟล์ CAD จากไดรฟ์ของคุณมาแสดงบนหน้าจอ N1 CAD Viewer
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* User Auth State Card */}
          <div className="p-4 rounded-xl border border-neutral-800 bg-neutral-950/40">
            {user ? (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  {user.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt={user.displayName || 'Google User'}
                      className="w-10 h-10 rounded-full border border-neutral-700"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-600/30 border border-blue-500/40 flex items-center justify-center text-blue-300 font-semibold text-sm">
                      {user.email?.charAt(0).toUpperCase() || 'G'}
                    </div>
                  )}
                  <div>
                    <div className="text-sm font-medium text-neutral-200 flex items-center gap-1.5">
                      {user.displayName || user.email}
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        เชื่อมต่อแล้ว
                      </span>
                    </div>
                    <div className="text-xs text-neutral-400">{user.email}</div>
                  </div>
                </div>

                <button
                  onClick={onSignOut}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-800 hover:bg-neutral-700 rounded-lg border border-neutral-700 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  ออกจากระบบ
                </button>
              </div>
            ) : (
              <div className="text-center py-2 space-y-3">
                <p className="text-sm text-neutral-300">
                  เข้าสู่ระบบ Google เพื่ออนุญาตให้แอปเปิดไฟล์ DXF จาก Google Drive ของคุณ
                </p>
                <div>
                  <GoogleSignInButton
                    onClick={onSignIn}
                    label="เข้าสู่ระบบด้วย Google"
                  />
                </div>
              </div>
            )}
          </div>

          {/* File ID input section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-neutral-200 flex items-center gap-1.5">
                Google Drive File ID หรือ Share Link
              </label>
              <button
                type="button"
                onClick={() => setFileInput('1hetVemsG8FNfRZv9mJeDewi52j1yFoQY')}
                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-3 h-3" />
                ใส่ค่าเริ่มต้น (1hetVems...)
              </button>
            </div>

            <div className="relative">
              <input
                type="text"
                value={fileInput}
                onChange={(e) => setFileInput(e.target.value)}
                placeholder="เช่น 1hetVemsG8FNfRZv9mJeDewi52j1yFoQY หรือ ลิงก์ Drive"
                className="w-full px-4 py-2.5 bg-neutral-950 border border-neutral-700 focus:border-blue-500 rounded-xl text-neutral-100 placeholder-neutral-500 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono text-xs"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="defaultCheckbox"
                checked={setAsDefault}
                onChange={(e) => setSetAsDefault(e.target.checked)}
                className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <label
                htmlFor="defaultCheckbox"
                className="text-xs text-neutral-300 select-none cursor-pointer"
              >
                บันทึกเป็นไฟล์เริ่มต้น (โหลดอัตโนมัติเมื่อเปิดแอป)
              </label>
            </div>
          </div>

          {/* Error and Success alerts */}
          {errorMessage && (
            <div className="p-3 rounded-xl bg-red-950/50 border border-red-500/30 flex items-start gap-2.5 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">{errorMessage}</div>
            </div>
          )}

          {successMessage && (
            <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/30 flex items-center gap-2.5 text-xs text-emerald-300">
              <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <div>{successMessage}</div>
            </div>
          )}

          {/* List of CAD files in Drive if user is logged in */}
          {user && (
            <div className="space-y-2 pt-2 border-t border-neutral-800">
              <div className="flex items-center justify-between text-xs text-neutral-400 font-medium">
                <span className="flex items-center gap-1.5">
                  <FileCheck className="w-3.5 h-3.5 text-blue-400" />
                  ไฟล์ CAD (.DXF / .DWG) ใน Google Drive ของคุณ
                </span>
                <button
                  onClick={() => accessToken && loadRecentFiles(accessToken)}
                  disabled={isLoadingRecent}
                  className="flex items-center gap-1 text-blue-400 hover:text-blue-300 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isLoadingRecent ? 'animate-spin' : ''}`}
                  />
                  รีเฟรช
                </button>
              </div>

              {isLoadingRecent ? (
                <div className="text-center py-6 text-xs text-neutral-500">
                  กำลังค้นหาไฟล์ CAD ใน Google Drive...
                </div>
              ) : recentFiles.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {recentFiles.map((f) => (
                    <div
                      key={f.id}
                      onClick={() => {
                        setFileInput(f.id);
                        handleLoadClicked(f.id, f.name);
                      }}
                      className="group flex items-center justify-between p-2.5 rounded-lg bg-neutral-950/60 hover:bg-neutral-800/80 border border-neutral-800 hover:border-neutral-700 cursor-pointer transition-all"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileCode2 className="w-4 h-4 text-blue-400 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-neutral-200 group-hover:text-blue-300 truncate">
                            {f.name}
                          </div>
                          <div className="text-[10px] text-neutral-500 flex items-center gap-2">
                            <span>ID: {f.id.slice(0, 12)}...</span>
                            {f.size && <span>• {formatFileSize(f.size)}</span>}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] px-2 py-1 bg-neutral-800 group-hover:bg-blue-600 group-hover:text-white rounded text-neutral-400 font-medium transition-colors">
                        เปิด
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-4 text-xs text-neutral-500 bg-neutral-950/30 rounded-lg border border-neutral-800/50">
                  ไม่พบไฟล์นามสกุล .dxf หรือ .dwg ใน Google Drive ของคุณ (สามารถพิมพ์ File ID ด้านบนได้โดยตรง)
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-800 bg-neutral-950/60">
          <div className="text-xs text-neutral-500">
            {currentDefaultFileId === extractDriveFileId(fileInput) && (
              <span className="text-blue-400 font-medium">★ ไฟล์เริ่มต้นปัจจุบัน</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors cursor-pointer"
            >
              ปิด
            </button>
            <button
              type="button"
              disabled={isLoadingFile || !fileInput.trim()}
              onClick={() => handleLoadClicked()}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-lg shadow-blue-600/20 transition-all cursor-pointer"
            >
              {isLoadingFile ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  กำลังดาวน์โหลด...
                </>
              ) : (
                <>
                  <HardDrive className="w-3.5 h-3.5" />
                  โหลดไฟล์เข้าวิวเวอร์
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
