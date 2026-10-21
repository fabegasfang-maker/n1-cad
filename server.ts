/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// สร้าง instance ของ LibreDWG wasm ใหม่ทุกครั้งที่แปลง (หน่วยความจำสะอาด ไม่สะสมจากไฟล์ก่อนหน้า)
const createLibreDwg: () => Promise<any> = require('dwg2dxf-converter/wasm/libredwg.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '150mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '150mb' }));

  // API Endpoint: Convert DWG to DXF via LibreDWG WebAssembly (Robust Direct Engine)
  app.post('/api/convert-dwg', async (req, res) => {
    let wasmVirtualIn = '';
    let wasmVirtualOut = '';

    try {
      let buffer: Buffer;
      let filename = 'drawing.dwg';

      if (typeof req.query.filename === 'string') {
        filename = decodeURIComponent(req.query.filename);
      } else if (typeof req.headers['x-filename'] === 'string') {
        filename = decodeURIComponent(req.headers['x-filename']);
      }

      if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      } else if (req.body?.base64) {
        buffer = Buffer.from(req.body.base64, 'base64');
        if (req.body.filename) filename = req.body.filename;
      } else {
        return res.status(400).json({ error: 'ไม่พบข้อมูลไฟล์ที่ส่งมา (No file data received)' });
      }

      if (buffer.length < 16) {
        return res.status(400).json({ error: 'ไฟล์มีขนาดเล็กเกินไปหรือไม่สมบูรณ์' });
      }

      // Check header signature
      const headerStr = buffer.subarray(0, 6).toString('ascii');
      console.log(`[DWG Converter] Processing ${filename} (${buffer.length} bytes, header: ${headerStr})`);

      const startTime = Date.now();
      const wasm = await createLibreDwg();

      // หมายเหตุ: ต้องใช้ชื่อไฟล์เสมือน "สั้นๆ" เท่านั้น
      // ชื่อยาว (เช่น input_<timestamp>_<random>.dwg) ทำให้ wasm ของ LibreDWG
      // เกิด "memory access out of bounds" ได้ เนื่องจากสร้าง instance แยกต่อคำขอ จึงไม่ชนกัน
      wasmVirtualIn = 'in.dwg';
      wasmVirtualOut = 'out.dxf';

      // Write DWG to Wasm virtual filesystem
      wasm.FS.writeFile(wasmVirtualIn, buffer);

      // Execute LibreDWG dwg2dxf safely
      let exitCode = -1;
      try {
        const convertFn = wasm.cwrap('convert_dwg_to_dxf', 'number', ['string', 'string']);
        exitCode = convertFn(wasmVirtualIn, wasmVirtualOut);
        console.log(`[DWG Converter] LibreDWG finished with exit code ${exitCode}`);
      } catch (convErr: any) {
        console.error('[DWG Converter] LibreDWG convertFn error:', convErr);
      }

      // Check if output DXF exists in virtual filesystem
      let outputBuffer: Uint8Array | null = null;
      try {
        outputBuffer = wasm.FS.readFile(wasmVirtualOut);
      } catch (readErr) {
        console.warn('[DWG Converter] virtualOut not found or unreadable:', readErr);
      }

      const duration = Date.now() - startTime;

      // If outputBuffer has valid content, use it!
      if (outputBuffer && outputBuffer.length > 50) {
        const dxfBuffer = Buffer.from(outputBuffer);
        const dxfBase64 = dxfBuffer.toString('base64');
        console.log(`[DWG Converter] Successfully produced DXF (${dxfBuffer.length} bytes, ${duration}ms)`);

        return res.json({
          success: true,
          filename: filename.replace(/\.dwg$/i, '.dxf'),
          dxfBase64,
          fileSize: dxfBuffer.length,
          duration,
          exitCode,
          note: exitCode !== 0 ? 'แปลงสำเร็จ (กู้คืนเอนทิตีที่รองรับโดย LibreDWG)' : 'แปลงสมบูรณ์ 100%',
        });
      }

      // If no DXF output was produced, explain why with clear actionable steps
      return res.status(422).json({
        success: false,
        error: `LibreDWG ไม่สามารถแปลงไฟล์ DWG นี้ได้ (รหัส: ${exitCode}) อาจเป็นเวอร์ชันใหม่ล่าสุดหรือมีฟีเจอร์เฉพาะของ Autodesk`,
        exitCode,
        suggestion: 'แนะนำให้เปิดไฟล์ใน AutoCAD แล้วสั่ง File -> Save As -> เลือกรูปแบบ "AutoCAD 2018 DXF (*.dxf)" หรือ "AutoCAD 2007 DXF (*.dxf)" แล้วนำมาเปิดได้ทันที 100%',
      });
    } catch (err: any) {
      console.error('[DWG Converter] Fatal error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'เกิดข้อผิดพลาดในการประมวลผลไฟล์ DWG',
      });
    }
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', dwgConverter: 'dwg2dxf-converter wasm' });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
