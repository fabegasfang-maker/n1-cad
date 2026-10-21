/**
 * Google Drive API Service for N1 CAD Viewer
 */

export interface GoogleDriveFileMeta {
  id: string;
  name: string;
  size?: string;
  mimeType?: string;
  modifiedTime?: string;
}

export interface GoogleDriveDownloadResult {
  fileId: string;
  filename: string;
  isDwg: boolean;
  buffer: ArrayBuffer;
  text?: string;
}

/**
 * Extracts Google Drive file ID from a URL or raw ID string.
 * Supports:
 * - Direct ID: 1hetVemsG8FNfRZv9mJeDewi52j1yFoQY
 * - https://drive.google.com/file/d/1hetVemsG8FNfRZv9mJeDewi52j1yFoQY/view?usp=sharing
 * - https://drive.google.com/open?id=1hetVemsG8FNfRZv9mJeDewi52j1yFoQY
 * - https://drive.google.com/uc?id=1hetVemsG8FNfRZv9mJeDewi52j1yFoQY
 */
export function extractDriveFileId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Match /file/d/ID
  const matchFileD = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (matchFileD && matchFileD[1]) {
    return matchFileD[1];
  }

  // Match id=ID
  const matchIdParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchIdParam && matchIdParam[1]) {
    return matchIdParam[1];
  }

  // Bare alphanumeric ID with possible hyphens or underscores
  const bareIdMatch = trimmed.match(/^([a-zA-Z0-9_-]{20,})$/);
  if (bareIdMatch && bareIdMatch[1]) {
    return bareIdMatch[1];
  }

  return trimmed;
}

/**
 * Get file metadata from Google Drive
 */
export async function getDriveFileMetadata(
  fileId: string,
  accessToken: string
): Promise<GoogleDriveFileMeta> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType,modifiedTime`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    let message = `Google Drive API error (${res.status})`;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed?.error?.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return await res.json();
}

/**
 * Download file binary/text content from Google Drive
 */
export async function downloadDriveFile(
  fileId: string,
  accessToken: string,
  knownFilename?: string
): Promise<GoogleDriveDownloadResult> {
  // If filename not provided, retrieve metadata first
  let filename = knownFilename || '';
  if (!filename) {
    try {
      const meta = await getDriveFileMetadata(fileId, accessToken);
      filename = meta.name || 'drawing.dxf';
    } catch {
      filename = 'drawing.dxf';
    }
  }

  const isDwg = filename.toLowerCase().endsWith('.dwg');

  // Fetch file content via Drive API alt=media
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    let message = `ไม่สามารถดาวน์โหลดไฟล์จาก Google Drive ได้ (${res.status})`;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed?.error?.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const buffer = await res.arrayBuffer();

  return {
    fileId,
    filename,
    isDwg,
    buffer,
  };
}

/**
 * Search or list CAD files (.dxf, .dwg) in user's Google Drive
 */
export async function listDriveCadFiles(
  accessToken: string
): Promise<GoogleDriveFileMeta[]> {
  const q = encodeURIComponent(
    "(name contains '.dxf' or name contains '.dwg' or name contains '.DXF' or name contains '.DWG') and trashed = false"
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,mimeType,modifiedTime)&pageSize=30&orderBy=modifiedTime desc`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  return data.files || [];
}
