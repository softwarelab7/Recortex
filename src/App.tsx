import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Camera, RefreshCw, Sparkles, Monitor, Download, Upload,
  Copy, Pen, Highlighter, ArrowRight, Type, Eraser, RotateCcw, Droplet, Undo2
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Configurar el worker de PDF.js explícitamente usando la URL del módulo
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

interface Selection { x: number; y: number; w: number; h: number }
interface Capture { id: string; dataUrl: string; dims: string }
type AnnotTool = 'pen' | 'highlight' | 'arrow' | 'text' | 'eraser' | 'blur' | null;
type ImageFormat = 'webp' | 'png' | 'jpeg';

const App: React.FC = () => {
  const [view, setView] = useState<'welcome' | 'video' | 'result'>('welcome');
  const [imageCaptured, setImageCaptured] = useState<string | null>(null);
  const [status, setStatus] = useState('Listo.  Esc=reset · Ctrl+D=descargar · Ctrl+C=copiar');
  const [isLocked, setIsLocked] = useState(false);
  const [fixedSize, setFixedSize] = useState<{ w: number; h: number } | null>(null);
  const [liveDims, setLiveDims] = useState<{ w: number; h: number } | null>(null);
  const [fileName, setFileName] = useState('Recorte_IA');
  const [format, setFormat] = useState<ImageFormat>('webp');
  const [quality, setQuality] = useState(1);

  const [history, setHistory] = useState<Capture[]>([]);
  const [annotTool, setAnnotTool] = useState<AnnotTool>(null);
  const [annotColor, setAnnotColor] = useState('#FF3B30');
  const [annotSize, setAnnotSize] = useState(3);
  const [isFlashing, setIsFlashing] = useState(false);
  const [annotHistory, setAnnotHistory] = useState<ImageData[]>([]);

  // PDF specific state
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState<number>(1);

  const videoRef = useRef<HTMLVideoElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const selCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotCanvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isDraggingRef = useRef(false);
  const selectionRef = useRef<Selection>({ x: 0, y: 0, w: 0, h: 0 });
  const isAnnotatingRef = useRef(false);
  const annotSnapshotRef = useRef<ImageData | null>(null);
  const arrowStartRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // ─── Renderizing Static Frame ──────────────────────────────
  const setupStaticCanvas = (width: number, height: number, drawInitialFn: (ctx: CanvasRenderingContext2D) => void) => {
    const sc = staticCanvasRef.current!;
    const ws = workspaceRef.current!;
    const cvs = selCanvasRef.current!;

    sc.width = width;
    sc.height = height;
    const ctx = sc.getContext('2d')!;
    drawInitialFn(ctx);

    const scale = Math.min(ws.clientWidth / width, ws.clientHeight / height);
    const displayW = Math.floor(width * scale);
    const displayH = Math.floor(height * scale);

    sc.style.display = 'block';
    sc.style.width = `${displayW}px`;
    sc.style.height = `${displayH}px`;

    cvs.width = displayW;
    cvs.height = displayH;
    cvs.style.width = `${displayW}px`;
    cvs.style.height = `${displayH}px`;

    setStatus(`${width}×${height}px — Arrastra para seleccionar sobre la imagen congelada.`);
    setView('video');
  };

  const renderPdfPage = async (pageNum: number, doc: pdfjsLib.PDFDocumentProxy) => {
    setStatus(`Renderizando página ${pageNum}...`);
    try {
      const page = await doc.getPage(pageNum);
      // Renderizar a 2.5x la resolución original para mayor calidad de recorte
      const viewport = page.getViewport({ scale: 2.5 });

      setupStaticCanvas(viewport.width, viewport.height, () => { }); // Prepara canvas vacío

      const renderContext = {
        canvasContext: staticCanvasRef.current!.getContext('2d')!,
        viewport: viewport,
        canvasFactory: {
          create: (width: number, height: number) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
          },
          reset: (canvasAndContext: any, width: number, height: number) => {
            canvasAndContext.canvas.width = width;
            canvasAndContext.canvas.height = height;
          },
          destroy: (canvasAndContext: any) => {
            canvasAndContext.canvas.width = 0;
            canvasAndContext.canvas.height = 0;
            canvasAndContext.canvas = null;
            canvasAndContext.context = null;
          }
        }
      } as any;

      await page.render(renderContext).promise;
      setStatus(`Página ${pageNum} de ${doc.numPages}. Arrastra para recortar.`);
    } catch (err) {
      setStatus(`Error renderizando página ${pageNum}.`);
    }
  };

  const startStream = async () => {
    try {
      const ms = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 7680 }, height: { ideal: 4320 }, frameRate: { ideal: 30 } },
        // @ts-ignore: standard prop in newer browsers to keep focus
        surfaceSwitching: 'exclude',
      });

      const v = videoRef.current!;
      v.srcObject = ms;

      v.onloadedmetadata = () => {
        v.play();
        requestAnimationFrame(() => {
          setTimeout(() => {
            setupStaticCanvas(v.videoWidth, v.videoHeight, (ctx) => ctx.drawImage(v, 0, 0));
            ms.getTracks().forEach(t => t.stop());
            v.srcObject = null;
          }, 100);
        });
      };
    } catch {
      setStatus('No se pudo iniciar la captura.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type === 'application/pdf') {
      setStatus('Cargando PDF...');
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const typedarray = new Uint8Array(ev.target?.result as ArrayBuffer);
          const pdf = await pdfjsLib.getDocument(typedarray).promise;
          setPdfDoc(pdf);
          setPdfPage(1);
          await renderPdfPage(1, pdf);
          setStatus(`PDF cargado. Página 1 de ${pdf.numPages}. Arrastra para recortar.`);
        } catch (err) {
          setStatus('Error al leer el PDF.');
        }
      };
      reader.readAsArrayBuffer(file);
    } else if (file.type.startsWith('image/')) {
      setStatus('Cargando imagen...');
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          setupStaticCanvas(img.width, img.height, (ctx) => ctx.drawImage(img, 0, 0));
          setStatus('Imagen cargada. Arrastra para recortar.');
        };
        img.src = ev.target?.result as string;
      };
      reader.readAsDataURL(file);
    }

    // Resetear input para permitir cargar el mismo archivo
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearAnnotations = () => {
    const c = annotCanvasRef.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setAnnotHistory([]);
  };

  const stopStream = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setPdfDoc(null);
    setPdfPage(1);
  }, []);

  const resetApp = useCallback(() => {
    stopStream();
    setView('welcome');
    if (imageCaptured) { URL.revokeObjectURL(imageCaptured); setImageCaptured(null); }
    setLiveDims(null);
    setAnnotTool(null);
    clearAnnotations();
    setStatus('Listo para capturar.');
    selCanvasRef.current?.getContext('2d')?.clearRect(0, 0, 9999, 9999);
  }, [stopStream, imageCaptured]);

  const undoAnnotation = useCallback(() => {
    setAnnotHistory(prev => {
      if (prev.length === 0) return prev;
      const newHist = [...prev];
      newHist.pop();
      const c = annotCanvasRef.current;
      if (c) {
        const ctx = c.getContext('2d')!;
        if (newHist.length > 0) ctx.putImageData(newHist[newHist.length - 1], 0, 0);
        else ctx.clearRect(0, 0, c.width, c.height);
      }
      return newHist;
    });
  }, []);

  const recapture = () => { setLiveDims(null); setAnnotTool(null); setTimeout(startStream, 80); };



  // ─── Selection drawing ───────────────────────────────────
  const drawRect = (sel: Selection) => {
    const cvs = selCanvasRef.current; if (!cvs) return;
    const ctx = cvs.getContext('2d')!;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.strokeStyle = '#007AFF'; ctx.lineWidth = 2;
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    ctx.fillStyle = 'rgba(0,122,255,0.12)';
    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
  };

  const handleSelDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = selCanvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    isDraggingRef.current = true;
    if (isLocked && fixedSize) {
      const source = staticCanvasRef.current!;
      const scale = rect.width / source.width;
      selectionRef.current = {
        x, y,
        w: fixedSize.w * scale,
        h: fixedSize.h * scale
      };
      drawRect(selectionRef.current);
    } else selectionRef.current = { x, y, w: 0, h: 0 };

    const magLens = document.getElementById('magnifier-lens');
    if (magLens) magLens.style.display = 'flex';
  };

  const handleSelMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current || isLocked) return;

    const rect = selCanvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Solo actualizar las referencias mutables sincrónicamente
    selectionRef.current.w = x - selectionRef.current.x;
    selectionRef.current.h = y - selectionRef.current.y;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      drawRect(selectionRef.current);

      const source = staticCanvasRef.current!;
      if (source && source.width) {
        // La escala ya es directa entre los píxeles lógicos del CSS y los internos de la imagen
        const scale = rect.width / source.width;

        setLiveDims({
          w: Math.round(Math.abs(selectionRef.current.w) / scale),
          h: Math.round(Math.abs(selectionRef.current.h) / scale)
        });

        const magLens = document.getElementById('magnifier-lens');
        if (magLens) {
          magLens.style.left = `${e.clientX}px`;
          magLens.style.top = `${e.clientY}px`;
        }

        const mag = magnifierCanvasRef.current;
        if (mag) {
          const cx = mag.getContext('2d', { alpha: false, willReadFrequently: true })!;
          cx.imageSmoothingEnabled = false;
          // Coordenadas exactas en la imagen fuente original
          const ix = x / scale;
          const iy = y / scale;
          // Capture 60x60 intrinsic pixels centered around cursor
          cx.drawImage(source, ix - 30, iy - 30, 60, 60, 0, 0, 120, 120);
        }
      }
    });
  };

  const handleSelUp = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setLiveDims(null);
    const magLens = document.getElementById('magnifier-lens');
    if (magLens) magLens.style.display = 'none';
    cropSelection();
  };

  // ─── Crop ────────────────────────────────────────────────
  const cropSelection = () => {
    const { x, y, w, h } = selectionRef.current;
    if (Math.abs(w) < 5 || Math.abs(h) < 5) return;

    const source = staticCanvasRef.current!;
    const rect = selCanvasRef.current!.getBoundingClientRect();
    const scale = rect.width / source.width;

    const logicalW = Math.abs(w);
    const logicalH = Math.abs(h);
    const logicalX = w < 0 ? x + w : x;
    const logicalY = h < 0 ? y + h : y;

    // Convert screen coordinates to intrinsic image pixels directly
    const ox = Math.round(logicalX / scale);
    const oy = Math.round(logicalY / scale);
    const cw = Math.round(logicalW / scale);
    const ch = Math.round(logicalH / scale);

    // Constrain crop to image bounds
    const safeX = Math.max(0, ox);
    const safeY = Math.max(0, oy);
    const safeW = Math.min(source.width - safeX, cw);
    const safeH = Math.min(source.height - safeY, ch);

    if (safeW <= 0 || safeH <= 0) return;

    const off = document.createElement('canvas');
    off.width = safeW;
    off.height = safeH;

    const ctx = off.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);

    const dataUrl = off.toDataURL(`image/${format}`, quality);
    setHistory(prev => [{ id: Date.now().toString(), dataUrl, dims: `${cw}×${ch}` }, ...prev].slice(0, 5));
    setImageCaptured(dataUrl); setAnnotTool(null); setView('result');
    setStatus(`Captura: ${cw}×${ch}px ✓`);
    setAnnotHistory([]);
    setIsFlashing(true);
    setTimeout(() => setIsFlashing(false), 400);
    setTimeout(() => {
      const ac = annotCanvasRef.current; const ws = workspaceRef.current;
      if (ac && ws) { ac.width = ws.clientWidth; ac.height = ws.clientHeight; }
    }, 100);
  };

  // ─── Annotations ─────────────────────────────────────────
  const getACtx = () => annotCanvasRef.current?.getContext('2d') ?? null;

  const handleAnnotDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!annotTool) return;
    const r = annotCanvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    isAnnotatingRef.current = true;
    const ctx = getACtx()!;
    if (annotTool === 'text') {
      const t = prompt('Texto:'); if (!t) { isAnnotatingRef.current = false; return; }
      ctx.globalAlpha = 1; ctx.fillStyle = annotColor;
      ctx.font = `bold ${annotSize * 6}px -apple-system, sans-serif`;
      ctx.fillText(t, x, y); isAnnotatingRef.current = false; return;
    }
    if (annotTool === 'arrow') {
      arrowStartRef.current = { x, y };
      annotSnapshotRef.current = ctx.getImageData(0, 0, annotCanvasRef.current!.width, annotCanvasRef.current!.height);
      return;
    }
    ctx.globalAlpha = annotTool === 'highlight' ? 0.35 : 1;
    ctx.strokeStyle = annotColor;
    ctx.lineWidth = annotTool === 'highlight' ? annotSize * 6 : annotSize;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x, y);
  };

  const handleAnnotMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isAnnotatingRef.current || !annotTool) return;
    const r = annotCanvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ctx = getACtx()!;
    if (annotTool === 'pen' || annotTool === 'highlight') { ctx.lineTo(x, y); ctx.stroke(); }
    else if (annotTool === 'eraser') ctx.clearRect(x - annotSize * 5, y - annotSize * 5, annotSize * 10, annotSize * 10);
    else if (annotTool === 'blur') {
      const radius = annotSize * 6;
      const resultImg = document.getElementById('result-img') as HTMLImageElement;
      if (!resultImg) return;
      const scaleX = resultImg.naturalWidth / annotCanvasRef.current!.width;
      const scaleY = resultImg.naturalHeight / annotCanvasRef.current!.height;
      const temp = document.createElement('canvas'); temp.width = radius * 2; temp.height = radius * 2;
      const ttx = temp.getContext('2d')!;
      ttx.drawImage(resultImg, (x - radius) * scaleX, (y - radius) * scaleY, radius * 2 * scaleX, radius * 2 * scaleY, 0, 0, radius * 2, radius * 2);
      const pix = document.createElement('canvas'); pix.width = Math.max(1, radius * 2 / 8); pix.height = Math.max(1, radius * 2 / 8);
      pix.getContext('2d')!.drawImage(temp, 0, 0, pix.width, pix.height);
      ttx.imageSmoothingEnabled = false;
      ttx.drawImage(pix, 0, 0, pix.width, pix.height, 0, 0, temp.width, temp.height);
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(temp, x - radius, y - radius); ctx.restore();
    }
    else if (annotTool === 'arrow' && arrowStartRef.current) {
      ctx.putImageData(annotSnapshotRef.current!, 0, 0);
      const { x: fx, y: fy } = arrowStartRef.current;
      const hl = 15 + annotSize * 2, ang = Math.atan2(y - fy, x - fx);
      ctx.globalAlpha = 1; ctx.strokeStyle = annotColor; ctx.fillStyle = annotColor;
      ctx.lineWidth = annotSize + 1; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - hl * Math.cos(ang - Math.PI / 6), y - hl * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(x - hl * Math.cos(ang + Math.PI / 6), y - hl * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }
  };

  const handleAnnotUp = () => {
    if (!isAnnotatingRef.current) return;
    isAnnotatingRef.current = false; getACtx()?.closePath(); arrowStartRef.current = null;
    const cvs = annotCanvasRef.current;
    if (cvs) setAnnotHistory(prev => [...prev, cvs.getContext('2d')!.getImageData(0, 0, cvs.width, cvs.height)].slice(-20));
  };

  // ─── Flatten image + annotations ─────────────────────────
  const getFlat = (): string => {
    const ac = annotCanvasRef.current;
    const baseImg = document.getElementById('result-img') as HTMLImageElement;
    if (!baseImg || !imageCaptured) return '';

    const flat = document.createElement('canvas');
    flat.width = baseImg.naturalWidth;
    flat.height = baseImg.naturalHeight;
    const ctx = flat.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    ctx.drawImage(baseImg, 0, 0);
    if (ac) {
      ctx.drawImage(ac, 0, 0, ac.width, ac.height, 0, 0, flat.width, flat.height);
    }
    return flat.toDataURL(format === 'jpeg' ? 'image/jpeg' : `image/${format}`, format === 'png' ? undefined : quality);
  };

  // ─── Actions ─────────────────────────────────────────────
  const copyToClipboard = async () => {
    if (!imageCaptured) return;
    try {
      const blob = await fetch(getFlat()).then(r => r.blob());
      const pngBlob: Blob = blob.type === 'image/png' ? blob : await new Promise(res => {
        const img = new Image(); img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          c.getContext('2d')!.drawImage(img, 0, 0); c.toBlob(b => res(b!), 'image/png');
        }; img.src = imageCaptured!;
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setStatus('¡Copiado al portapapeles! ✓');
    } catch { setStatus('No se pudo copiar (requiere HTTPS).'); }
  };

  const downloadImage = () => {
    if (!imageCaptured) return;
    const a = document.createElement('a');
    a.download = `${fileName.trim() || 'Recorte_IA'}.${format}`;
    a.href = getFlat(); a.click();
    setStatus(`Descargado: ${a.download} ✓`);
  };



  // ─── Keyboard shortcuts & PDF Navigation ──────────────────────────────────
  const goPrevPage = useCallback(async () => {
    if (pdfDoc && pdfPage > 1) {
      const p = pdfPage - 1; setPdfPage(p); await renderPdfPage(p, pdfDoc);
    }
  }, [pdfDoc, pdfPage]);

  const goNextPage = useCallback(async () => {
    if (pdfDoc && pdfPage < pdfDoc.numPages) {
      const p = pdfPage + 1; setPdfPage(p); await renderPdfPage(p, pdfDoc);
    }
  }, [pdfDoc, pdfPage]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resetApp();
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); downloadImage(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && view === 'result') { e.preventDefault(); copyToClipboard(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && view === 'result') { e.preventDefault(); undoAnnotation(); }
      if (view === 'video' && pdfDoc) {
        if (e.key === 'ArrowLeft') goPrevPage();
        if (e.key === 'ArrowRight') goNextPage();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [view, imageCaptured, resetApp, undoAnnotation, pdfDoc, goPrevPage, goNextPage]); // eslint-disable-line

  const annotCursor = annotTool === 'eraser' ? 'cell' : annotTool === 'text' ? 'text' : annotTool ? 'crosshair' : 'default';

  return (
    <>
      <header>
        <div className="logo"><Camera size={22} /> RECORTADOR <span>PRO</span></div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span className="shortcut-hint"><kbd>Esc</kbd> reset · <kbd>Ctrl+D</kbd> descargar · <kbd>Ctrl+C</kbd> copiar</span>
          <button className="btn btn-secondary" onClick={resetApp}><RefreshCw size={15} /> Resetear</button>
        </div>
      </header>

      <main>
        <div id="workspace" ref={workspaceRef}>
          {view === 'welcome' && (
            <div className="capture-prompt">
              <Sparkles size={60} />
              <h2>Elegancia y Precisión</h2>
              <p>Captura tu pantalla o carga un documento para empezar</p><br />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                <button className="btn btn-primary" style={{ width: 'auto' }} onClick={startStream}>
                  <Monitor size={16} /> Seleccionar Pantalla
                </button>
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="image/*,application/pdf" style={{ display: 'none' }} />
                <button className="btn btn-secondary" style={{ width: 'auto' }} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} /> Cargar Archivo
                </button>
              </div>
            </div>
          )}

          {view === 'video' && pdfDoc && (
            <div style={{ position: 'absolute', top: 15, left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', gap: '8px', background: 'var(--surface)', padding: '8px 16px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
              <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.9rem', width: 'auto' }} disabled={pdfPage <= 1} onClick={goPrevPage}>
                ◄ Anterior
              </button>
              <span style={{ margin: 'auto 6px', fontSize: '1rem', fontWeight: 600 }}>{pdfPage} / {pdfDoc.numPages}</span>
              <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.9rem', width: 'auto' }} disabled={pdfPage >= pdfDoc.numPages} onClick={goNextPage}>
                Siguiente ►
              </button>
            </div>
          )}

          {isFlashing && <div className="shutter-flash" />}

          <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
          <div style={{ position: 'relative', display: view === 'video' ? 'block' : 'none' }}>
            <canvas ref={staticCanvasRef} id="static-preview" />
            <canvas ref={selCanvasRef} id="selection-canvas"
              onMouseDown={handleSelDown} onMouseMove={handleSelMove} onMouseUp={handleSelUp} />
          </div>

          <div id="magnifier-lens" className="magnifier-lens" style={{ display: 'none' }}>
            <canvas ref={magnifierCanvasRef} width={120} height={120} />
          </div>

          {view === 'result' && <>
            <img id="result-img" src={imageCaptured!} alt="Resultado" />
            <canvas ref={annotCanvasRef} id="annotation-canvas" style={{ cursor: annotCursor }}
              onMouseDown={handleAnnotDown} onMouseMove={handleAnnotMove} onMouseUp={handleAnnotUp} />
          </>}

          {liveDims && <div className="live-dims">{liveDims.w} × {liveDims.h} px</div>}

          {view === 'result' && (
            <div className="annot-toolbar">
              {([
                { t: 'pen' as AnnotTool, icon: <Pen size={15} />, label: 'Lápiz' },
                { t: 'highlight' as AnnotTool, icon: <Highlighter size={15} />, label: 'Resaltador' },
                { t: 'arrow' as AnnotTool, icon: <ArrowRight size={15} />, label: 'Flecha' },
                { t: 'text' as AnnotTool, icon: <Type size={15} />, label: 'Texto' },
                { t: 'blur' as AnnotTool, icon: <Droplet size={15} />, label: 'Censurar/Desenfocar' },
                { t: 'eraser' as AnnotTool, icon: <Eraser size={15} />, label: 'Borrar' },
              ]).map(({ t, icon, label }) => (
                <button key={t!} title={label} className={`annot-btn ${annotTool === t ? 'active' : ''}`}
                  onClick={() => setAnnotTool(annotTool === t ? null : t)}>{icon}</button>
              ))}
              <div className="annot-divider" />
              <input type="color" value={annotColor} onChange={e => setAnnotColor(e.target.value)} className="color-picker" title="Color" />
              <input type="range" min={1} max={8} value={annotSize} onChange={e => setAnnotSize(+e.target.value)} className="size-slider" title="Tamaño" />
              <div className="annot-divider" />
              <button className="annot-btn" title="Deshacer (Ctrl+Z)" onClick={undoAnnotation} disabled={annotHistory.length === 0}><Undo2 size={15} /></button>
              <button className="annot-btn" title="Borrar todo" onClick={clearAnnotations}><RotateCcw size={15} /></button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="card glass">
            <h3>Acciones</h3>
            <button className="btn btn-secondary" style={{ marginTop: '0' }} onClick={copyToClipboard} disabled={!imageCaptured}>
              <Copy size={15} /> Copiar al portapapeles
            </button>
            {imageCaptured && (
              <input className="api-input" style={{ marginTop: '8px', marginBottom: '0' }}
                placeholder="Nombre del archivo…" value={fileName} onChange={e => setFileName(e.target.value)} spellCheck={false} />
            )}
            <button className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={downloadImage} disabled={!imageCaptured}>
              <Download size={15} /> Descargar .{format}
            </button>
            {imageCaptured && (
              <button className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={recapture}>
                <Monitor size={15} /> Nuevo Recorte
              </button>
            )}
          </div>

          <div className="card glass">
            <h3>Formato de Exportación</h3>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              {(['webp', 'png', 'jpeg'] as ImageFormat[]).map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`btn ${format === f ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, padding: '8px', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                  {f}
                </button>
              ))}
            </div>
            {format !== 'png' && (
              <label style={{ fontSize: '0.8rem', display: 'block', color: 'var(--muted)' }}>
                Calidad: {Math.round(quality * 100)}%
                <input type="range" min={50} max={100} value={Math.round(quality * 100)}
                  onChange={e => setQuality(+e.target.value / 100)}
                  style={{ width: '100%', marginTop: '6px', accentColor: 'var(--primary)' }} />
              </label>
            )}
          </div>

          <div className="card glass">
            <h3>Tamaños Predeterminados</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {([[512, 512, '512×512'], [1024, 1024, '1024×1024'], [1280, 720, '720p'], [1920, 1080, '1080p']] as [number, number, string][]).map(([w, h, l]) => (
                <button key={l} className="btn btn-secondary" style={{ padding: '8px', fontSize: '0.78rem' }}
                  onClick={() => { setFixedSize({ w, h }); setIsLocked(true); setStatus(`Tamaño fijo: ${w}×${h}.`); }}>
                  {l}
                </button>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', marginTop: '10px', cursor: 'pointer' }}>
              <input type="checkbox" checked={isLocked} onChange={e => setIsLocked(e.target.checked)} /> Bloquear tamaño fijo
            </label>
          </div>

          {history.length > 0 && (
            <div className="card glass">
              <h3>Historial</h3>
              <div className="history-grid">
                {history.map(cap => (
                  <div key={cap.id} className="history-thumb"
                    onClick={() => { setImageCaptured(cap.dataUrl); setView('result'); setAnnotTool(null); }}>
                    <img src={cap.dataUrl} alt={cap.dims} />
                    <span>{cap.dims}</span>
                  </div>
                ))}
              </div>
            </div>
          )}


        </aside>
      </main>

      <footer>
        <div>{status}</div>
        <div>v3.0 · React</div>
      </footer>
    </>
  );
};

export default App;
