pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
const { PDFDocument, StandardFonts, rgb, degrees, PageSizes, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, decodePDFRawStream } = PDFLib;

/* ================= THEME TOGGLE (light/dark) ================= */
(function(){
  const THEME_KEY = "ieditpdf-theme";
  const btn = document.getElementById("theme-toggle");
  if(!btn) return;
  // Mirrors theme-init.js: default is always light until the person
  // explicitly picks a theme (no following the OS/browser's dark-mode
  // setting for the initial theme).
  function currentTheme(){
    let saved = null;
    try{ saved = localStorage.getItem(THEME_KEY); }catch(e){}
    if(saved === "light" || saved === "dark") return saved;
    return "light";
  }
  btn.addEventListener("click", function(){
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
  });
})();
let _thaiFontBytesCache = null;
function thaiFontBytes(){
  if(_thaiFontBytesCache) return _thaiFontBytesCache;
  const bin = atob(window.__THAI_FONT_B64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  _thaiFontBytesCache = arr;
  return arr;
}

// Sarabun (same font bundled for the quickedit tool, see quickedit-fonts-data.js)
// used specifically for OCR's invisible searchable-text layer. Loma — the font
// thaiFontBytes() above returns — has a pdf-lib/fontkit font-subsetting quirk
// where certain Thai combining marks get assigned a WRONG codepoint in the
// generated PDF's ToUnicode table: text renders fine (it's invisible anyway)
// but copying/searching it comes out corrupted, e.g. a tone mark extracting as
// an unrelated character. Reproduced in isolation with plain pdf-lib + fontkit
// (no OCR, no browser involved), so it's a font/library issue, not an OCR
// recognition issue. Sarabun does not exhibit the same corruption in testing
// (only "ำ" occasionally extracts with a harmless extra "า", a much smaller
// issue than a mark turning into a wrong character). Kept as a separate
// function from thaiFontBytes() rather than changing it directly, since that
// one is also used for VISIBLE text (page numbers, watermark) where swapping
// the font changes the printed appearance — a decision worth making on its
// own rather than as a side effect of this fix.
let _ocrFontBytesCache = null;
function ocrFontBytes(){
  if(_ocrFontBytesCache) return _ocrFontBytesCache;
  const list = window.__QE_FONTS || [];
  const entry = list.find(f => f.key === "sarabun") || list[0];
  if(!entry) return thaiFontBytes(); // shouldn't happen, but never leave OCR without a Thai font
  const bin = atob(entry.b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  _ocrFontBytesCache = arr;
  return arr;
}


/* ---------- utils ---------- */
function fmtBytes(b){
  if(b < 1024) return b + " B";
  if(b < 1024*1024) return (b/1024).toFixed(1) + " KB";
  return (b/1024/1024).toFixed(2) + " MB";
}
function readFileAsArrayBuffer(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}
/* ---------- custom filename before download ---------- */
// Strips characters that are invalid in Windows/macOS filenames and trims
// stray leading/trailing dots or spaces. Falls back to "document" if the
// result would otherwise be empty (e.g. user cleared the field).
function sanitizeFilename(name){
  name = (name || "").toString();
  name = name.replace(/[\\/:*?"<>|]/g, "_");
  name = name.replace(/[\s.]+$/, "").replace(/^[\s.]+/, "");
  name = name.trim();
  if(!name) name = "document";
  return name;
}
// Fills a filename <input> with a sensible default base name (no extension)
// — called every time a new result is produced, so the field always starts
// in sync with the new output, but stays editable before the user downloads.
function setFilenameDefault(inputEl, base){
  if(inputEl) inputEl.value = base;
}
// Reads the current value of a filename <input> (falling back to `base` if
// empty), sanitizes it, and appends `ext` (e.g. ".pdf") to build the final
// download filename.
function resolveFilename(inputEl, base, ext){
  const raw = (inputEl && inputEl.value && inputEl.value.trim()) ? inputEl.value : base;
  return sanitizeFilename(raw) + ext;
}
const _escapeHtmlMap = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c)=>_escapeHtmlMap[c]);
}
function setStatus(el, msg, kind){
  el.className = "status" + (kind ? " " + kind : "");
  // msg is always treated as plain text (escaped) — only the loading spinner markup is trusted HTML.
  el.innerHTML = (kind === "loading" ? '<span class="spinner"></span>' : '') + escapeHtml(msg);
}
// pdf-lib does not actually support encrypted PDFs. `PDFDocument.load(..., {
// ignoreEncryption: true })` only suppresses its "can't load encrypted PDF"
// error — it does NOT decrypt anything. The file's real content streams stay
// exactly as they were (still genuinely encrypted ciphertext), but pdf-lib
// has no idea and treats them as opaque data. On save(), it carries the
// original /Encrypt dictionary reference straight through to the new
// trailer, producing a file that every standard PDF reader will then try to
// decrypt — corrupting content that was never actually decrypted in the
// first place. The result "succeeds" with no error in this app, downloads
// fine, and then simply won't open anywhere.
//
// Many real-world "encrypted" PDFs only have an *owner* password set (no
// user/open password) — they already open with no prompt in every viewer,
// including this app's own in-app preview (which uses pdf.js, a library
// that DOES support real decryption). To avoid bothering the user with an
// error for exactly this common, harmless case, every menu that touches
// pdf-lib calls autoDecryptIfNeeded() right after loading: if the file is
// encrypted, it silently tries a real decrypt (via this app's own
// PDFDecrypt library, from the "ปลดล็อกรหัสผ่าน" menu) using an empty
// password first. If that succeeds — the owner-password-only case — the
// menu just continues on the decrypted copy; the user never sees anything
// went wrong. Only a file that truly requires a user-supplied password (or
// uses an encryption scheme PDFDecrypt doesn't support) falls through to a
// friendly error pointing at the "ปลดล็อกรหัสผ่าน" menu, where the user can
// type the real password themselves.
async function autoDecryptIfNeeded(doc, rawBytes){
  if(!doc.isEncrypted) return { doc, bytes: rawBytes };
  if(window.PDFDecrypt){
    try{
      const decBytes = await PDFDecrypt.decryptPDF(new Uint8Array(rawBytes.slice(0)), "");
      const newDoc = await PDFDocument.load(decBytes);
      return { doc: newDoc, bytes: decBytes.slice().buffer };
    }catch(e){
      const msg = (e && e.message) || "";
      if(/incorrect password/i.test(msg)){
        throw new Error('ไฟล์นี้ตั้งรหัสผ่านสำหรับเปิดไฟล์ไว้จริง (ไม่ใช่แค่ป้องกันการแก้ไข) เมนูนี้ปลดล็อกให้อัตโนมัติไม่ได้ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อใส่รหัสผ่านที่ถูกต้องก่อน แล้วนำไฟล์ที่ปลดล็อกแล้วมาใช้งานเมนูนี้อีกครั้ง');
      }
      if(/unsupported encryption/i.test(msg)){
        throw new Error('ไฟล์นี้เข้ารหัสด้วยวิธีที่ระบบยังไม่รองรับการถอดรหัสอัตโนมัติ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อลองปลดล็อกด้วยตนเอง');
      }
      // fall through to the generic message below for any other failure
    }
  }
  throw new Error('ไฟล์นี้มีการเข้ารหัส/ตั้งรหัสผ่านไว้ และระบบไม่สามารถปลดล็อกให้อัตโนมัติได้ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อปลดล็อกไฟล์ก่อน แล้วนำไฟล์ที่ปลดล็อกแล้วมาใช้งานเมนูนี้อีกครั้ง');
}
async function renderPageCanvas(arrayBuffer, pageNum, targetWidth){
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const page = await doc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, numPages: doc.numPages, doc, scale };
}
function parseRanges(str, maxPage){
  const set = new Set();
  str.split(",").forEach(part=>{
    part = part.trim();
    if(!part) return;
    if(part.includes("-")){
      const [a,b] = part.split("-").map(s=>parseInt(s.trim(),10));
      if(!isNaN(a) && !isNaN(b)){
        const lo = Math.max(1, Math.min(a,b)), hi = Math.min(maxPage, Math.max(a,b));
        for(let i=lo;i<=hi;i++) set.add(i);
      }
    } else {
      const n = parseInt(part,10);
      if(!isNaN(n) && n>=1 && n<=maxPage) set.add(n);
    }
  });
  return Array.from(set).sort((a,b)=>a-b);
}
function rangesToString(pages){
  if(!pages.length) return "";
  const sorted = [...pages].sort((a,b)=>a-b);
  const out = [];
  let start = sorted[0], prev = sorted[0];
  for(let i=1;i<=sorted.length;i++){
    const cur = sorted[i];
    if(cur === prev+1){ prev = cur; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur; prev = cur;
  }
  return out.join(",");
}

/* ---------- tabs (grouped dropdown / accordion menu) ---------- */
(function(){
  const nav = document.getElementById("tabs-groups");
  if(!nav) return;
  const groups = Array.from(nav.querySelectorAll(".tab-group"));

  function closeAllGroups(except){
    groups.forEach(g=>{ if(g !== except) g.classList.remove("open"); });
  }

  groups.forEach(group=>{
    const toggle = group.querySelector(".group-toggle");
    toggle.addEventListener("click", (e)=>{
      e.stopPropagation();
      const willOpen = !group.classList.contains("open");
      closeAllGroups(group);
      group.classList.toggle("open", willOpen);
    });
  });

  // close any open dropdown when clicking elsewhere on the page
  document.addEventListener("click", (e)=>{
    if(!nav.contains(e.target)) closeAllGroups(null);
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape") closeAllGroups(null);
  });

  nav.querySelectorAll(".group-menu button[data-tab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      nav.querySelectorAll(".group-menu button[data-tab]").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
      groups.forEach(g=>g.classList.remove("active-group"));

      btn.classList.add("active");
      document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
      const parentGroup = btn.closest(".tab-group");
      if(parentGroup) parentGroup.classList.add("active-group");
      closeAllGroups(null);
      document.dispatchEvent(new CustomEvent("pdftools:tabchange", { detail: { tab: btn.dataset.tab } }));
    });
  });
})();

/* ---------- generic drop-zone wiring ---------- */
function wireDrop(dropEl, inputEl, onFiles, accept){
  dropEl.addEventListener("click", ()=> inputEl.click());
  inputEl.addEventListener("change", ()=> { if(inputEl.files.length) onFiles(Array.from(inputEl.files)); });
  ["dragenter","dragover"].forEach(evt=> dropEl.addEventListener(evt, e=>{ e.preventDefault(); dropEl.classList.add("drag"); }));
  ["dragleave","drop"].forEach(evt=> dropEl.addEventListener(evt, e=>{ e.preventDefault(); dropEl.classList.remove("drag"); }));
  dropEl.addEventListener("drop", e=>{
    const matches = accept
      ? (f)=> accept.some(ext=> f.name.toLowerCase().endsWith(ext))
      : (f)=> f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    const files = Array.from(e.dataTransfer.files).filter(matches);
    if(files.length) onFiles(files);
  });
}

/* ---------- lazy-load a vendor script on first use (keeps heavy libraries
   like html2canvas/docx-preview/xlsx out of the initial page load — they're
   only fetched the moment a conversion that actually needs them runs) ---------- */
const _scriptLoadCache = {};
function loadScriptOnce(src){
  if(_scriptLoadCache[src]) return _scriptLoadCache[src];
  _scriptLoadCache[src] = new Promise((resolve, reject)=>{
    const s = document.createElement("script");
    s.src = src;
    s.onload = ()=> resolve();
    s.onerror = ()=>{ delete _scriptLoadCache[src]; reject(new Error("โหลดโมดูลไม่สำเร็จ: " + src)); };
    document.head.appendChild(s);
  });
  return _scriptLoadCache[src];
}

/* ---------- shared helpers for the "office/html -> PDF" converters ---------- */
function dataUrlToBytes(dataUrl){
  const base64 = dataUrl.split(",")[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
// Slices a (possibly very tall) canvas into as many fixed-size PDF pages as
// needed (A4 portrait by default) and appends them to pdfDoc. Used for
// flowing content (HTML, Excel tables) that doesn't already know its own
// page breaks. Returns the number of pages added.
async function addCanvasAsPdfPages(pdfDoc, canvas, opts){
  opts = opts || {};
  const pageWidthPt = opts.pageWidthPt || 595.28;
  const pageHeightPt = opts.pageHeightPt || 841.89;
  const marginPt = opts.marginPt != null ? opts.marginPt : 24;
  const contentWidthPt = pageWidthPt - marginPt*2;
  const contentHeightPt = pageHeightPt - marginPt*2;
  const scale = contentWidthPt / canvas.width; // pt per source px
  const pxPerPage = Math.max(1, Math.floor(contentHeightPt / scale));
  const totalPages = Math.max(1, Math.ceil(canvas.height / pxPerPage));
  for(let i=0;i<totalPages;i++){
    const sy = i*pxPerPage;
    const sh = Math.min(pxPerPage, canvas.height - sy);
    if(sh <= 0) break;
    const slice = document.createElement("canvas");
    slice.width = canvas.width; slice.height = sh;
    slice.getContext("2d").drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
    const bytes = dataUrlToBytes(slice.toDataURL("image/jpeg", 0.92));
    const img = await pdfDoc.embedJpg(bytes);
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    const shPt = sh*scale;
    page.drawImage(img, { x: marginPt, y: pageHeightPt - marginPt - shPt, width: contentWidthPt, height: shPt });
  }
  return totalPages;
}
// Adds one canvas as a single PDF page sized to match the canvas's own
// aspect ratio (converted px->pt via pxToPt). Used for docx-preview page
// sections, which already come pre-paginated at the document's real page
// size, so each one becomes exactly one PDF page with no extra slicing.
async function addCanvasAsSinglePdfPage(pdfDoc, canvas, pxToPt){
  const bytes = dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
  const img = await pdfDoc.embedJpg(bytes);
  const w = canvas.width*pxToPt, h = canvas.height*pxToPt;
  const page = pdfDoc.addPage([w, h]);
  page.drawImage(img, { x:0, y:0, width:w, height:h });
}

/* ================= MERGE ================= */
(function(){
  const drop = document.getElementById("merge-drop");
  const input = document.getElementById("merge-input");
  const list = document.getElementById("merge-list");
  const runBtn = document.getElementById("merge-run");
  const previewBtn = document.getElementById("merge-preview-btn");
  const clearBtn = document.getElementById("merge-clear");
  const status = document.getElementById("merge-status");
  const result = document.getElementById("merge-result");
  const downloadBtn = document.getElementById("merge-download");
  const filenameInput = document.getElementById("merge-filename-input");
  const previewOverlay = document.getElementById("merge-preview-overlay");
  const previewClose = document.getElementById("merge-preview-close");
  const previewGrid = document.getElementById("merge-preview-grid");
  let items = [];
  let outputBlob = null;

  function closePreview(){ previewOverlay.classList.remove("show"); }
  previewClose.onclick = closePreview;
  previewOverlay.addEventListener("click", (e)=>{ if(e.target === previewOverlay) closePreview(); });
  document.addEventListener("keydown", (e)=>{ if(e.key === "Escape" && previewOverlay.classList.contains("show")) closePreview(); });

  async function buildMergedBytes(){
    const out = await PDFDocument.create();
    for(const it of items){
      const src = await PDFDocument.load(it.buffer.slice(0), { ignoreEncryption:true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p=>out.addPage(p));
    }
    return out.save();
  }

  previewBtn.onclick = async ()=>{
    if(!items.length) return;
    previewGrid.innerHTML = '<div class="preview-loading">กำลังรวมไฟล์เพื่อแสดงตัวอย่าง...</div>';
    previewOverlay.classList.add("show");
    previewBtn.disabled = true;
    try{
      const mergedBytes = await buildMergedBytes();
      const pdfDoc = await pdfjsLib.getDocument({ data: mergedBytes.slice(0) }).promise;
      previewGrid.innerHTML = "";
      const stack = document.createElement("div");
      stack.className = "preview-pages";
      previewGrid.appendChild(stack);
      for(let i=1;i<=pdfDoc.numPages;i++){
        const page = await pdfDoc.getPage(i);
        const baseWidth = page.getViewport({ scale:1 }).width;
        const viewport = page.getViewport({ scale: 420 / baseWidth });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const wrap = document.createElement("div");
        wrap.className = "preview-page";
        wrap.appendChild(canvas);
        const num = document.createElement("div");
        num.className = "num"; num.textContent = `หน้า ${i} / ${pdfDoc.numPages}`;
        wrap.appendChild(num);
        stack.appendChild(wrap);
      }
    }catch(e){
      previewGrid.innerHTML = "";
      const err = document.createElement("div");
      err.className = "preview-loading";
      err.textContent = "ไม่สามารถแสดงตัวอย่างได้: " + e.message;
      previewGrid.appendChild(err);
    }
    previewBtn.disabled = items.length === 0;
  };

  function render(){
    closePreview();
    list.innerHTML = "";
    items.forEach((it, idx)=>{
      const card = document.createElement("div");
      card.className = "filecard";
      const thumb = document.createElement("canvas");
      card.appendChild(it.thumbCanvas ? it.thumbCanvas.cloneNode() : thumb);
      if(it.thumbCanvas){
        const c = card.querySelector("canvas");
        c.width = it.thumbCanvas.width; c.height = it.thumbCanvas.height;
        c.getContext("2d").drawImage(it.thumbCanvas, 0, 0);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${escapeHtml(it.file.name)}</div><div class="sub">${it.pageCount} หน้า · ${fmtBytes(it.file.size)}</div>`;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.innerHTML = `
        <button class="iconbtn" data-act="up" title="ขึ้น">↑</button>
        <button class="iconbtn" data-act="down" title="ลง">↓</button>
        <button class="iconbtn" data-act="rm" title="ลบ">✕</button>`;
      actions.querySelector('[data-act="up"]').onclick = ()=>{ if(idx>0){ [items[idx-1],items[idx]]=[items[idx],items[idx-1]]; render(); } };
      actions.querySelector('[data-act="down"]').onclick = ()=>{ if(idx<items.length-1){ [items[idx+1],items[idx]]=[items[idx],items[idx+1]]; render(); } };
      actions.querySelector('[data-act="rm"]').onclick = ()=>{ items.splice(idx,1); render(); };
      card.appendChild(meta); card.appendChild(actions);
      list.appendChild(card);
    });
    runBtn.disabled = items.length < 2;
    previewBtn.disabled = items.length === 0;
    result.classList.remove("show"); outputBlob = null;
  }

  async function addFiles(files){
    for(const file of files){
      const buf = await readFileAsArrayBuffer(file);
      try{
        let srcDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption:true });
        let itemBuf = buf;
        ({ doc: srcDoc, bytes: itemBuf } = await autoDecryptIfNeeded(srcDoc, buf));
        const pageCount = srcDoc.getPageCount();
        let thumbCanvas = null;
        try{ thumbCanvas = (await renderPageCanvas(itemBuf, 1, 88)).canvas; }catch(e){}
        items.push({ file, buffer: itemBuf, pageCount, thumbCanvas });
      }catch(e){
        setStatus(status, `ไม่สามารถอ่านไฟล์ ${file.name} ได้ (${e.message})`, "err");
      }
    }
    render();
  }
  wireDrop(drop, input, addFiles);
  clearBtn.onclick = ()=>{ items = []; render(); setStatus(status,"",""); };

  runBtn.onclick = async ()=>{
    setStatus(status, "กำลังรวมไฟล์...", "loading");
    runBtn.disabled = true;
    try{
      const bytes = await buildMergedBytes();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      const totalPages = items.reduce((sum, it)=> sum + it.pageCount, 0);
      setStatus(status, "รวมไฟล์สำเร็จ", "ok");
      result.querySelector(".stats").innerHTML = `<b>${totalPages}</b> หน้า รวม · <b>${fmtBytes(outputBlob.size)}</b>`;
      const firstName = items.length ? items[0].file.name.replace(/\.pdf$/i,"") : "merged";
      setFilenameDefault(filenameInput, `${firstName}_merged`);
      result.classList.add("show");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = items.length < 2;
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, "merged", ".pdf")); };
})();

/* ================= SPLIT ================= */
(function(){
  const drop = document.getElementById("split-drop");
  const input = document.getElementById("split-input");
  const body = document.getElementById("split-body");
  const grid = document.getElementById("split-grid");
  const rangeInput = document.getElementById("split-range");
  const allBtn = document.getElementById("split-all");
  const noneBtn = document.getElementById("split-none");
  const modeSel = document.getElementById("split-mode");
  const runBtn = document.getElementById("split-run");
  const status = document.getElementById("split-status");
  const result = document.getElementById("split-result");
  const downloadBtn = document.getElementById("split-download");
  const filenameEl = document.getElementById("split-filename");
  const filenameInput = document.getElementById("split-filename-input");
  const filenameExtEl = document.getElementById("split-filename-ext");
  const removeBtn = document.getElementById("split-remove");
  let buffer = null, fileName = "document", numPages = 0, selected = new Set();
  let outputBlob = null, outputName = "", outputExt = ".pdf";

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    setStatus(status, "กำลังโหลดหน้าเอกสาร...", "loading");
    body.style.display = "block";
    grid.innerHTML = "";
    selected = new Set();
    rangeInput.value = "";
    try{
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      numPages = pdfjsDoc.numPages;
      for(let i=1;i<=numPages;i++){
        const page = await pdfjsDoc.getPage(i);
        const viewport = page.getViewport({ scale: 70 / page.getViewport({scale:1}).width });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const cell = document.createElement("div");
        cell.className = "pagecell";
        cell.appendChild(canvas);
        const num = document.createElement("div");
        num.className = "num"; num.textContent = i;
        cell.appendChild(num);
        cell.onclick = ()=>{
          if(selected.has(i)) selected.delete(i); else selected.add(i);
          cell.classList.toggle("sel");
          rangeInput.value = rangesToString(Array.from(selected));
          runBtn.disabled = selected.size === 0;
        };
        grid.appendChild(cell);
      }
      setStatus(status, `โหลดสำเร็จ · ทั้งหมด ${numPages} หน้า`, "ok");
    }catch(e){
      setStatus(status, "ไม่สามารถอ่านไฟล์นี้ได้: " + e.message, "err");
    }
  });

  function syncGridFromRange(){
    selected = new Set(parseRanges(rangeInput.value, numPages));
    Array.from(grid.children).forEach((cell, i)=> cell.classList.toggle("sel", selected.has(i+1)));
    runBtn.disabled = selected.size === 0;
  }
  rangeInput.addEventListener("input", syncGridFromRange);
  allBtn.onclick = ()=>{ rangeInput.value = numPages ? `1-${numPages}` : ""; syncGridFromRange(); };
  noneBtn.onclick = ()=>{ rangeInput.value = ""; syncGridFromRange(); };

  runBtn.onclick = async ()=>{
    const pages = Array.from(selected).sort((a,b)=>a-b);
    if(!pages.length) return;
    setStatus(status, "กำลังประมวลผล...", "loading");
    runBtn.disabled = true;
    try{
      let src = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc: src } = await autoDecryptIfNeeded(src, buffer));
      if(modeSel.value === "single"){
        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, pages.map(p=>p-1));
        copied.forEach(p=>out.addPage(p));
        const bytes = await out.save();
        outputBlob = new Blob([bytes], { type:"application/pdf" });
        outputName = `${fileName}_extracted`;
        outputExt = ".pdf";
        result.querySelector(".stats").innerHTML = `<b>${pages.length}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      } else {
        const zip = new JSZip();
        for(const p of pages){
          const out = await PDFDocument.create();
          const [copied] = await out.copyPages(src, [p-1]);
          out.addPage(copied);
          const bytes = await out.save();
          zip.file(`${fileName}_page_${p}.pdf`, bytes);
        }
        outputBlob = await zip.generateAsync({ type:"blob" });
        outputName = `${fileName}_pages`;
        outputExt = ".zip";
        result.querySelector(".stats").innerHTML = `<b>${pages.length}</b> ไฟล์ในชุด ZIP · <b>${fmtBytes(outputBlob.size)}</b>`;
      }
      setFilenameDefault(filenameInput, outputName);
      if(filenameExtEl) filenameExtEl.textContent = outputExt;
      setStatus(status, "เสร็จสิ้น", "ok");
      result.classList.add("show");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = selected.size === 0;
  };
  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; numPages = 0; selected = new Set();
    grid.innerHTML = ""; rangeInput.value = "";
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, outputName, outputExt)); };
})();

/* ================= COMPRESS ================= */
(function(){
  const drop = document.getElementById("compress-drop");
  const input = document.getElementById("compress-input");
  const body = document.getElementById("compress-body");
  const scaleSel = document.getElementById("compress-scale");
  const qRange = document.getElementById("compress-quality");
  const qVal = document.getElementById("compress-q-val");
  const runBtn = document.getElementById("compress-run");
  const progress = document.getElementById("compress-progress");
  const status = document.getElementById("compress-status");
  const result = document.getElementById("compress-result");
  const downloadBtn = document.getElementById("compress-download");
  const filenameEl = document.getElementById("compress-filename");
  const filenameInput = document.getElementById("compress-filename-input");
  const removeBtn = document.getElementById("compress-remove");
  let buffer = null, fileName = "document", originalSize = 0, outputBlob = null;

  qRange.addEventListener("input", ()=> qVal.textContent = qRange.value + "%");

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    originalSize = file.size;
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, `พร้อมประมวลผล · ขนาดต้นฉบับ ${fmtBytes(originalSize)}`, "");
  });

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    progress.style.display = "block"; progress.value = 0;
    const scale = parseFloat(scaleSel.value);
    const quality = parseInt(qRange.value,10) / 100;
    try{
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      let srcLib = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc: srcLib } = await autoDecryptIfNeeded(srcLib, buffer));
      const out = await PDFDocument.create();
      const n = pdfjsDoc.numPages;
      for(let i=1;i<=n;i++){
        setStatus(status, `กำลังประมวลผลหน้า ${i}/${n}...`, "loading");
        const page = await pdfjsDoc.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const jpgUrl = canvas.toDataURL("image/jpeg", quality);
        const jpgBytes = Uint8Array.from(atob(jpgUrl.split(",")[1]), c=>c.charCodeAt(0));
        const jpgImage = await out.embedJpg(jpgBytes);
        const origPage = srcLib.getPage(i-1);
        const { width, height } = origPage.getSize();
        const newPage = out.addPage([width, height]);
        newPage.drawImage(jpgImage, { x:0, y:0, width, height });
        progress.value = Math.round((i/n)*100);
        await new Promise(r=>setTimeout(r,0));
      }
      const bytes = await out.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      const pct = Math.round((1 - outputBlob.size/originalSize) * 100);
      result.querySelector(".stats").innerHTML =
        `<b>${fmtBytes(originalSize)}</b> → <b>${fmtBytes(outputBlob.size)}</b>` +
        (pct > 0 ? ` (ลดลง ${pct}%)` : ` (ไฟล์ใหญ่ขึ้น — ลองลดความละเอียด/คุณภาพ)`);
      setFilenameDefault(filenameInput, `${fileName}_compressed`);
      result.classList.add("show");
      setStatus(status, "บีบอัดสำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    progress.style.display = "none";
    runBtn.disabled = false;
  };
  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; originalSize = 0;
    progress.style.display = "none"; progress.value = 0;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_compressed`, ".pdf")); };
})();

/* ================= PAGE NUMBERS ================= */
(function(){
  const drop = document.getElementById("pagenum-drop");
  const input = document.getElementById("pagenum-input");
  const body = document.getElementById("pagenum-body");
  const posSel = document.getElementById("pagenum-pos");
  const fmtInput = document.getElementById("pagenum-format");
  const startInput = document.getElementById("pagenum-start");
  const sizeInput = document.getElementById("pagenum-size");
  const runBtn = document.getElementById("pagenum-run");
  const status = document.getElementById("pagenum-status");
  const result = document.getElementById("pagenum-result");
  const downloadBtn = document.getElementById("pagenum-download");
  const filenameEl = document.getElementById("pagenum-filename");
  const filenameInput = document.getElementById("pagenum-filename-input");
  const removeBtn = document.getElementById("pagenum-remove");
  const presetsEl = document.getElementById("pagenum-presets");
  const previewEl = document.getElementById("pagenum-preview");
  let buffer = null, fileName = "document", outputBlob = null, pageCount = null;

  const DEFAULT_FORMAT = "{เลขหน้า} / {จำนวนหน้า}";

  function renderTemplate(template, n, total){
    return String(template)
      .replace(/\{เลขหน้า\}/g, n)
      .replace(/\{จำนวนหน้า\}/g, total)
      .replace(/\{n\}/g, n)
      .replace(/\{total\}/g, total);
  }

  function updatePreview(){
    const template = fmtInput.value || DEFAULT_FORMAT;
    const start = parseInt(startInput.value, 10) || 0;
    const total = pageCount || Math.max(start, 12);
    const text = renderTemplate(template, start, total);
    previewEl.textContent = `ตัวอย่าง: ${text}`;
    let matched = false;
    presetsEl.querySelectorAll(".chip").forEach(chip=>{
      const isActive = chip.dataset.format === template;
      chip.classList.toggle("active", isActive);
      if(isActive) matched = true;
    });
  }

  presetsEl.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      fmtInput.value = chip.dataset.format;
      updatePreview();
    });
  });
  fmtInput.addEventListener("input", updatePreview);
  startInput.addEventListener("input", updatePreview);

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, "", "");
    pageCount = null;
    try{
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      pageCount = pdfjsDoc.numPages;
    }catch(e){ pageCount = null; }
    updatePreview();
  });

  updatePreview();

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    setStatus(status, "กำลังใส่เลขหน้า...", "loading");
    try{
      let doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc } = await autoDecryptIfNeeded(doc, buffer));
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(thaiFontBytes(), { subset: true });
      const pages = doc.getPages();
      const total = pages.length;
      const start = parseInt(startInput.value,10) || 0;
      const size = parseFloat(sizeInput.value) || 11;
      const margin = 28;
      const template = fmtInput.value || DEFAULT_FORMAT;
      pages.forEach((page, idx)=>{
        const n = start + idx;
        const text = renderTemplate(template, n, total);
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(text, size);
        let x, y;
        const pos = posSel.value;
        if(pos.endsWith("center")) x = width/2 - textWidth/2;
        else if(pos.endsWith("right")) x = width - margin - textWidth;
        else x = margin;
        y = pos.startsWith("top") ? height - margin : margin - size*0.3;
        page.drawText(text, { x, y, size, font, color: rgb(0.25,0.25,0.28) });
      });
      const bytes = await doc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `<b>${total}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_numbered`);
      result.classList.add("show");
      setStatus(status, "สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = false;
  };
  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; pageCount = null;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
    updatePreview();
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_numbered`, ".pdf")); };
})();

/* ================= WATERMARK ================= */
(function(){
  const drop = document.getElementById("watermark-drop");
  const input = document.getElementById("watermark-input");
  const body = document.getElementById("watermark-body");
  const textInput = document.getElementById("watermark-text");
  const colorInput = document.getElementById("watermark-color");
  const sizeRange = document.getElementById("watermark-size");
  const sizeVal = document.getElementById("watermark-size-val");
  const opRange = document.getElementById("watermark-opacity");
  const opVal = document.getElementById("watermark-opacity-val");
  const rotRange = document.getElementById("watermark-rotate");
  const rotVal = document.getElementById("watermark-rotate-val");
  const runBtn = document.getElementById("watermark-run");
  const status = document.getElementById("watermark-status");
  const result = document.getElementById("watermark-result");
  const downloadBtn = document.getElementById("watermark-download");
  const filenameEl = document.getElementById("watermark-filename");
  const filenameInput = document.getElementById("watermark-filename-input");
  const removeBtn = document.getElementById("watermark-remove");
  const previewPlaceholder = document.getElementById("watermark-preview-placeholder");
  const previewCanvas = document.getElementById("watermark-preview");
  const previewHint = document.getElementById("watermark-preview-hint");
  const resetPosBtn = document.getElementById("watermark-reset-pos");
  const positionModeGroup = document.getElementById("watermark-position-mode");
  const positionModeBtns = positionModeGroup ? Array.from(positionModeGroup.querySelectorAll(".chip")) : [];
  let buffer = null, fileName = "document", outputBlob = null;
  let basePageCanvas = null, pageScale = 1;
  // Where the user dragged the watermark to, as a fraction of the page (0-1,
  // y measured from the TOP like canvas space) — null means "not moved yet",
  // in which case the watermark stays auto-centered (horizontally centered
  // on its own text width, vertically on the page) exactly as before this
  // feature existed. Kept across text/size/color/rotation changes (the user
  // chose a spot; tweaking the wording shouldn't un-choose it), but reset
  // whenever a different file is loaded or the mode is switched back to
  // "auto" — that switch is the deliberate "just fix it in the center, I
  // don't want to think about this" choice, so it should actually put the
  // watermark back there, not just hide the controls while leaving a stray
  // drag position in effect.
  let customPos = null;
  // "auto" = always centered, dragging disabled (the safe default for anyone
  // who doesn't want to fuss with placement — nothing they do on the preview
  // can nudge it off-center by accident). "custom" = drag-to-position, as
  // built earlier. A plain two-way toggle rather than leaving dragging
  // always-on everywhere: an accidental click/drag on the preview used to
  // silently move the watermark even for people who never meant to touch
  // it, which is exactly the footgun this mode switch removes.
  let positionMode = "auto";

  function applyPositionModeUI(){
    positionModeBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === positionMode));
    const customActive = positionMode === "custom" && !!basePageCanvas;
    previewCanvas.classList.toggle("draggable", customActive);
    if(previewHint) previewHint.style.display = customActive ? "flex" : "none";
  }

  function drawPreview(){
    if(!basePageCanvas) return;
    const ctx = previewCanvas.getContext("2d");
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.drawImage(basePageCanvas, 0, 0);
    const text = textInput.value || "WATERMARK";
    const sizePt = parseFloat(sizeRange.value) || 48;
    const opacity = (parseInt(opRange.value, 10) || 0) / 100;
    const rotation = parseFloat(rotRange.value) || 0;
    const color = colorInput.value || "#808080";
    const fontPx = sizePt * pageScale;
    ctx.save();
    ctx.font = `${fontPx}px "Noto Sans Thai","Leelawadee UI","Tahoma",sans-serif`;
    ctx.textBaseline = "alphabetic";
    const textWidthPx = ctx.measureText(text).width;
    const cax = customPos ? customPos.fracX * previewCanvas.width : previewCanvas.width / 2 - textWidthPx / 2;
    const cay = customPos ? customPos.fracY * previewCanvas.height : previewCanvas.height / 2;
    ctx.translate(cax, cay);
    ctx.rotate(-rotation * Math.PI / 180);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function resetPreview(){
    basePageCanvas = null;
    customPos = null;
    positionMode = "auto";
    previewCanvas.style.display = "none";
    previewPlaceholder.style.display = "flex";
    applyPositionModeUI();
  }

  // Drag-to-reposition directly on the preview canvas — only live in "custom"
  // mode (see positionMode above). Wherever the pointer is becomes the
  // watermark's new anchor point, in real time (pointer events cover both
  // mouse and touch). A single click also counts as a one-step "move it
  // here" — no separate click-vs-drag distinction needed since there's
  // nothing else on this canvas to click.
  function setPosFromEvent(e){
    const rect = previewCanvas.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    customPos = {
      fracX: Math.max(0, Math.min(1, px / previewCanvas.width)),
      fracY: Math.max(0, Math.min(1, py / previewCanvas.height)),
    };
    drawPreview();
  }
  previewCanvas.addEventListener("pointerdown", (e)=>{
    if(!basePageCanvas || positionMode !== "custom") return;
    previewCanvas.setPointerCapture(e.pointerId);
    previewCanvas.classList.add("dragging");
    setPosFromEvent(e);
  });
  previewCanvas.addEventListener("pointermove", (e)=>{
    if(!previewCanvas.classList.contains("dragging")) return;
    setPosFromEvent(e);
  });
  function endWatermarkDrag(){ previewCanvas.classList.remove("dragging"); }
  previewCanvas.addEventListener("pointerup", endWatermarkDrag);
  previewCanvas.addEventListener("pointercancel", endWatermarkDrag);
  if(resetPosBtn){
    resetPosBtn.addEventListener("click", ()=>{ customPos = null; drawPreview(); });
  }
  positionModeBtns.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const mode = btn.dataset.mode === "custom" ? "custom" : "auto";
      if(mode === positionMode) return;
      positionMode = mode;
      if(positionMode === "auto") customPos = null; // "fix it centered" should actually re-center, not just hide the controls
      applyPositionModeUI();
      drawPreview();
    });
  });

  sizeRange.addEventListener("input", ()=>{ sizeVal.textContent = sizeRange.value; drawPreview(); });
  opRange.addEventListener("input", ()=>{ opVal.textContent = opRange.value + "%"; drawPreview(); });
  rotRange.addEventListener("input", ()=>{ rotVal.textContent = rotRange.value + "°"; drawPreview(); });
  textInput.addEventListener("input", drawPreview);
  colorInput.addEventListener("input", drawPreview);

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, "", "");
    customPos = null; // new document → start back at the auto-centered default
    positionMode = "auto";
    try{
      const { canvas: baseCanvas, scale } = await renderPageCanvas(buffer, 1, 220);
      basePageCanvas = baseCanvas;
      pageScale = scale;
      previewCanvas.width = baseCanvas.width;
      previewCanvas.height = baseCanvas.height;
      previewPlaceholder.style.display = "none";
      previewCanvas.style.display = "block";
      applyPositionModeUI();
      drawPreview();
    }catch(e){ resetPreview(); }
  });

  function hexToRgb01(hex){
    const v = parseInt(hex.slice(1), 16);
    return { r: ((v>>16)&255)/255, g: ((v>>8)&255)/255, b: (v&255)/255 };
  }

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    setStatus(status, "กำลังใส่ลายน้ำ...", "loading");
    try{
      let doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc } = await autoDecryptIfNeeded(doc, buffer));
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(thaiFontBytes(), { subset: true });
      const text = textInput.value || "WATERMARK";
      const size = parseFloat(sizeRange.value);
      const opacity = parseInt(opRange.value,10) / 100;
      const rotation = parseFloat(rotRange.value);
      const { r,g,b } = hexToRgb01(colorInput.value);
      const textWidth = font.widthOfTextAtSize(text, size);
      doc.getPages().forEach(page=>{
        // page.getSize() returns the RAW page box, ignoring any /Rotate the
        // page carries — but the preview was built from pdf.js, which DOES
        // render pages according to their /Rotate (so a portrait-looking
        // scanned invoice whose raw box is actually landscape-with-Rotate-90
        // still previews upright). If we naively drew at (raw width/2,
        // raw height/2) with the plain slider rotation on such a page, a
        // PDF viewer applying that same /Rotate on display would end up
        // showing the watermark at the wrong spot, size-relative-position,
        // and angle — exactly the "preview vs. exported file don't match"
        // symptom. So: compute the position/rotation in the same VISUAL
        // (as-displayed) space the preview used, then transform back into
        // the page's raw, pre-rotation coordinate space before calling
        // drawText, which always operates in raw space regardless of
        // /Rotate.
        const { width: W, height: H } = page.getSize();
        const angle = ((Math.round(page.getRotation().angle) % 360) + 360) % 360; // normalize to 0/90/180/270
        const swapped = angle === 90 || angle === 270;
        const Wv = swapped ? H : W, Hv = swapped ? W : H; // visual (as-displayed) page dimensions

        // customPos.fracY is measured from the top like canvas space (where
        // it was captured while dragging on the preview, itself built in
        // this same visual space); flipped here since PDF y grows from the
        // bottom. No customPos yet → same auto-centered default this always
        // used, just now expressed in visual space.
        const visX = customPos ? customPos.fracX * Wv : Wv/2 - textWidth/2;
        const visY = customPos ? Hv - customPos.fracY * Hv : Hv/2;

        // Map the visual-space anchor back to the page's raw coordinate
        // space. Derived from how each /Rotate value maps raw page corners
        // to their displayed position (verified against pdf-lib's actual
        // rendered output for each angle) — an identity for 0, and the
        // appropriate axis swap/flip for 90/180/270.
        let x, y;
        if(angle === 90){ x = W - visY; y = visX; }
        else if(angle === 180){ x = W - visX; y = H - visY; }
        else if(angle === 270){ x = visY; y = H - visX; }
        else { x = visX; y = visY; }

        page.drawText(text, {
          x, y,
          size, font, color: rgb(r,g,b), opacity,
          // The same +angle composition that maps the visual anchor point
          // back to raw space also applies to rotation: a page displayed
          // rotated by `angle` needs its raw-space text rotation offset by
          // that same amount for the FINAL on-screen angle to still read as
          // the plain `rotation` value the user picked (verified the same
          // way as the position mapping above).
          rotate: degrees(rotation + angle),
        });
      });
      const bytes = await doc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `<b>${doc.getPageCount()}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_watermarked`);
      result.classList.add("show");
      setStatus(status, "สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = false;
  };
  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
    resetPreview();
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_watermarked`, ".pdf")); };
})();


/* ================= QUICK EDIT (client-side overlay, no install) ================= */
(function(){
  const drop = document.getElementById("quickedit-drop");
  const input = document.getElementById("quickedit-input");
  const body = document.getElementById("quickedit-body");
  // The panel's own intro (title/badge, description, warning box) is only
  // useful before a file is loaded — once editing starts it just pushes the
  // toolbar/canvas further down, so it's hidden (via CSS scoped to this
  // class, see style.css) while a file is open and restored when it isn't.
  const panelEl = document.getElementById("panel-quickedit");
  const filenameEl = document.getElementById("quickedit-filename");
  const removeBtn = document.getElementById("quickedit-remove");
  const prevBtn = document.getElementById("quickedit-prev");
  const nextBtn = document.getElementById("quickedit-next");
  const pageIndicator = document.getElementById("quickedit-page-indicator");
  const stageEl = document.getElementById("quickedit-stage");
  const canvasEl = document.getElementById("quickedit-canvas");
  const textLayerEl = document.getElementById("quickedit-textlayer");
  const downloadBtn = document.getElementById("quickedit-download");
  const filenameInput = document.getElementById("quickedit-filename-input");
  const resetBtn = document.getElementById("quickedit-reset-edits");
  const status = document.getElementById("quickedit-status");
  const popover = document.getElementById("quickedit-popover");
  const popoverHead = document.getElementById("quickedit-popover-head");
  const colorLabel = document.getElementById("quickedit-color-label");
  const textarea = document.getElementById("quickedit-textarea");
  const fontsizeInput = document.getElementById("quickedit-fontsize");
  const fontSelect = document.getElementById("quickedit-fontfamily");
  const boldCheckbox = document.getElementById("quickedit-bold");
  const italicCheckbox = document.getElementById("quickedit-italic");
  const underlineCheckbox = document.getElementById("quickedit-underline");
  const alignGroup = document.getElementById("quickedit-align-group");
  const undoBtn = document.getElementById("quickedit-undo");
  const redoBtn = document.getElementById("quickedit-redo");
  const colorInput = document.getElementById("quickedit-color");
  const applyBtn = document.getElementById("quickedit-apply");
  const cancelBtn = document.getElementById("quickedit-cancel");
  const modeEditBtn = document.getElementById("quickedit-mode-edit");
  const modeAddBtn = document.getElementById("quickedit-mode-addtext");
  const hintEl = document.getElementById("quickedit-hint");
  const previewEl = document.getElementById("quickedit-preview");
  const previewMaskEl = document.getElementById("quickedit-preview-mask");
  if(!drop || !input) return;

  const EDIT_HINT = "คลิกกล่องข้อความสีม่วงบนเอกสารเพื่อแก้ไข";
  const ADD_HINT = "คลิกตำแหน่งที่ต้องการบนเอกสารเพื่อวางข้อความใหม่ (กดปุ่ม \"+ เพิ่มข้อความ\" อีกครั้งเพื่อออกจากโหมดนี้)";

  const RENDER_WIDTH = 720;
  let originalBuffer = null, fileName = "document";
  let workingDoc = null, workingBytes = null;
  let qeFontCache = {};
  let currentPage = 1, numPages = 1, pageScale = 1;
  // The PDF page's own coordinate origin, as reported by pdf.js's viewport
  // (viewport.viewBox[0]/[1] — i.e. the page's effective MediaBox x0/y0).
  // Almost always [0,0], but NOT always: some PDF generators (this module's
  // "cover box" edit was originally built and tested only against those)
  // emit a MediaBox whose lower-left corner isn't the origin — e.g. a Canva
  // export can have a MediaBox like [0, 7.83, 595.5, 850.08]. item.transform
  // (from pdf.js) and pdf-lib's drawText/drawRectangle both work in this same
  // raw, un-normalized page space, so that part stays correct on its own.
  // But every canvas-PIXEL <-> PDF-POINT conversion below was hand-rolled
  // assuming the page's y=0 sits exactly at the bottom of the canvas (i.e.
  // origin (0,0)) — good enough when it's true, silently wrong by
  // `pageOriginY * pageScale` canvas pixels when it isn't. On a page like
  // that Canva export, this shifted the ink-extent flood-fill's seed row far
  // enough to undercount the cover rectangle's ascent by several points,
  // leaving the top portion of the original (bold, wide-tracked) glyphs
  // exposed above the "erased" rectangle — which then shows through the
  // freshly drawn replacement text as a doubled/"ghosted" look. Captured
  // once per render in renderCurrentPage() and applied by every
  // canvas<->PDF conversion (measureInkExtent, sampleBgColor,
  // sampleInkColor, and the click/drag position handlers) so all of them
  // agree on where the page's true (0,0) sits, regardless of what the
  // source PDF's MediaBox happens to be.
  let pageOriginX = 0, pageOriginY = 0;

  /* ============================================================
   * TRUE TEXT REMOVAL — content-stream surgical editor.
   *
   * The normal quickedit path never removes the original glyph data: it
   * samples the background, paints an opaque rectangle over the old text,
   * then draws the new text on top. That works well but leaves a flat-color
   * box over non-flat backgrounds (photos, gradients, logos) and leaves the
   * original text bytes inside the file.
   *
   * This module attempts something stronger first: locate the EXACT
   * Tj/TJ operator(s) in the page's raw content stream that produced the
   * clicked text, and delete those bytes outright — genuinely removing the
   * glyphs from the file, no cover rectangle needed.
   *
   * Safety model (deliberately conservative — see design notes below):
   * we only ever touch an operator when we can PROVE, from the content
   * stream's own operators alone (no font-metric/glyph-width knowledge
   * required), that nothing else in the file depends on its position
   * advancing text-state. Concretely: an operator is "isolated" when (a)
   * its own start position was set by an explicit repositioning operator
   * (Tm/Td/TD/T-star/BT — i.e. not inherited by implicit advance from a
   * previous show-text call), AND (b) the very next show-text operator (if
   * any) is ALSO explicitly repositioned. If both hold, the operator's
   * glyphs can be deleted outright with zero risk to surrounding text,
   * because nothing downstream relies on where it would have left the text
   * cursor.
   *
   * This intentionally does NOT try to replicate pdf.js's own text-item
   * merging heuristics (which use real glyph widths we don't have access
   * to) — instead it matches the clicked pdf.js item's start position, and
   * additionally requires the item to be "isolated" as defined above. Many
   * real documents split a line/sentence into several implicitly-chained
   * Tj/TJ calls; those safely and correctly fall back to the existing
   * cover-box edit below, unchanged. Validated against pdf.js's actual
   * getTextContent() output (position formula, font/width-change item
   * boundaries) and against this app's own embedded Thai CID fonts.
   * ============================================================ */
  const ContentEditor = (function(){
    const WHITESPACE = new Set([0x00,0x09,0x0a,0x0c,0x0d,0x20]);
    const DELIM = new Set(['(',')','<','>','[',']','{','}','/','%'].map(c=>c.charCodeAt(0)));
    function isWhite(b){ return WHITESPACE.has(b); }
    function isDelim(b){ return DELIM.has(b); }
    function isRegular(b){ return !isWhite(b) && !isDelim(b); }

    function tokenize(bytes){
      const n = bytes.length;
      let i = 0;
      const ops = [];
      let pendingArgs = [];

      function skipWs(){
        while(i < n){
          if(bytes[i] === 0x25){
            while(i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
          } else if(isWhite(bytes[i])){
            i++;
          } else break;
        }
      }
      function readLiteralString(){
        const start = i;
        i++;
        let depth = 1;
        const out = [];
        while(i < n && depth > 0){
          const b = bytes[i];
          if(b === 0x5c){
            i++;
            if(i >= n) break;
            const e = bytes[i];
            if(e === 0x6e) out.push(0x0a);
            else if(e === 0x72) out.push(0x0d);
            else if(e === 0x74) out.push(0x09);
            else if(e === 0x62) out.push(0x08);
            else if(e === 0x66) out.push(0x0c);
            else if(e === 0x28) out.push(0x28);
            else if(e === 0x29) out.push(0x29);
            else if(e === 0x5c) out.push(0x5c);
            else if(e >= 0x30 && e <= 0x37){
              let oct = e - 0x30; let cnt = 1;
              while(cnt < 3 && i+1 < n && bytes[i+1] >= 0x30 && bytes[i+1] <= 0x37){ i++; oct = oct*8 + (bytes[i]-0x30); cnt++; }
              out.push(oct & 0xff);
            } else if(e === 0x0a){ /* line continuation */ }
            else if(e === 0x0d){ if(i+1<n && bytes[i+1]===0x0a) i++; }
            else out.push(e);
            i++;
          } else if(b === 0x28){ depth++; out.push(b); i++; }
          else if(b === 0x29){ depth--; i++; if(depth>0) out.push(b); }
          else { out.push(b); i++; }
        }
        return { t:'str', v: Uint8Array.from(out), start, end: i };
      }
      function readHexString(){
        const start = i;
        i++;
        const hexchars = [];
        while(i < n && bytes[i] !== 0x3e){
          const b = bytes[i];
          if(!isWhite(b)) hexchars.push(String.fromCharCode(b));
          i++;
        }
        i++;
        if(hexchars.length % 2 === 1) hexchars.push('0');
        const out = new Uint8Array(hexchars.length/2);
        for(let k=0;k<out.length;k++){ out[k] = parseInt(hexchars[k*2]+hexchars[k*2+1], 16); }
        return { t:'str', v: out, start, end: i };
      }
      function readName(){
        const start = i;
        i++;
        let s = '';
        while(i < n && isRegular(bytes[i])){
          if(bytes[i] === 0x23 && i+2 < n){
            const hex = String.fromCharCode(bytes[i+1]) + String.fromCharCode(bytes[i+2]);
            if(/^[0-9a-fA-F]{2}$/.test(hex)){ s += String.fromCharCode(parseInt(hex,16)); i += 3; continue; }
          }
          s += String.fromCharCode(bytes[i]); i++;
        }
        return { t:'name', v:s, start, end:i };
      }
      function readNumber(){
        const start = i;
        if(bytes[i]===0x2b||bytes[i]===0x2d) i++;
        while(i<n && ((bytes[i]>=0x30&&bytes[i]<=0x39)||bytes[i]===0x2e)) i++;
        const s = String.fromCharCode.apply(null, bytes.slice(start,i));
        return { t:'num', v: parseFloat(s)||0, start, end:i };
      }
      function readDictOrRaw(){
        const start = i;
        i += 2;
        let depth = 1;
        while(i < n && depth > 0){
          if(bytes[i]===0x3c && bytes[i+1]===0x3c){ depth++; i+=2; }
          else if(bytes[i]===0x3e && bytes[i+1]===0x3e){ depth--; i+=2; }
          else i++;
        }
        return { t:'raw', start, end:i };
      }
      function readArray(){
        const start = i;
        i++;
        const items = [];
        skipWs();
        while(i < n && bytes[i] !== 0x5d){
          items.push(readOperand());
          skipWs();
        }
        i++;
        return { t:'arr', v: items, start, end: i };
      }
      function readOperand(){
        skipWs();
        const b = bytes[i];
        if(b === 0x28) return readLiteralString();
        if(b === 0x3c){
          if(bytes[i+1] === 0x3c) return readDictOrRaw();
          return readHexString();
        }
        if(b === 0x2f) return readName();
        if(b === 0x5b) return readArray();
        if((b>=0x30&&b<=0x39)||b===0x2b||b===0x2d||b===0x2e) return readNumber();
        return null;
      }

      while(i < n){
        skipWs();
        if(i >= n) break;
        const b = bytes[i];
        if(b === 0x28 || b === 0x3c || b === 0x2f || b === 0x5b){
          pendingArgs.push(readOperand());
          continue;
        }
        if((b>=0x30&&b<=0x39)||((b===0x2b||b===0x2d||b===0x2e) && i+1<n)){
          pendingArgs.push(readNumber());
          continue;
        }
        if(b===0x42 && bytes[i+1]===0x49 && (i+2>=n || isWhite(bytes[i+2]))){ // "BI" inline image
          const start = pendingArgs.length ? pendingArgs[0].start : i;
          let j = i;
          while(j < n && !(bytes[j]===0x49 && bytes[j+1]===0x44 && isWhite(bytes[j-1]))) j++;
          j += 2; j++;
          let k = j;
          while(k < n-1){
            if(bytes[k]===0x45 && bytes[k+1]===0x49 && (k===0||isWhite(bytes[k-1]))) break;
            k++;
          }
          k += 2;
          ops.push({ name:'__INLINE_IMAGE__', args: [], opStart: start, opEnd: k });
          i = k;
          pendingArgs = [];
          continue;
        }
        const start = i;
        while(i < n && isRegular(bytes[i])) i++;
        const opName = String.fromCharCode.apply(null, bytes.slice(start, i));
        if(opName.length === 0){ i++; continue; }
        const opStart = pendingArgs.length ? pendingArgs[0].start : start;
        ops.push({ name: opName, args: pendingArgs, opStart, opEnd: i });
        pendingArgs = [];
      }
      return ops;
    }

    function matMul(m1, m2){
      return [
        m1[0]*m2[0] + m1[1]*m2[2],
        m1[0]*m2[1] + m1[1]*m2[3],
        m1[2]*m2[0] + m1[3]*m2[2],
        m1[2]*m2[1] + m1[3]*m2[3],
        m1[4]*m2[0] + m1[5]*m2[2] + m2[4],
        m1[4]*m2[1] + m1[5]*m2[3] + m2[5],
      ];
    }
    const IDENTITY = [1,0,0,1,0,0];

    function walkTextPositions(bytes){
      const ops = tokenize(bytes);
      const candidates = [];
      let ctm = IDENTITY, ctmStack = [];
      let gState = { fontName: null, fontSize: 0, Th: 100, TL: 0, Ts: 0 };
      let gStack = [];
      let Tm = IDENTITY, Tlm = IDENTITY, positionReliable = false;

      function currentTransform(){
        const trmLinear = [ gState.fontSize * (gState.Th/100), 0, 0, gState.fontSize, 0, gState.Ts ];
        return matMul(matMul(trmLinear, Tm), ctm);
      }
      function moveTo(tx, ty){
        Tlm = matMul([1,0,0,1,tx,ty], Tlm);
        Tm = Tlm;
        positionReliable = true;
      }

      for(const op of ops){
        switch(op.name){
          case 'q': ctmStack.push(ctm); gStack.push(Object.assign({}, gState)); break;
          case 'Q': if(ctmStack.length) ctm = ctmStack.pop(); if(gStack.length) gState = gStack.pop(); break;
          case 'cm': if(op.args.length === 6) ctm = matMul(op.args.map(a=>a.v), ctm); break;
          case 'BT': Tm = IDENTITY; Tlm = IDENTITY; positionReliable = true; break;
          case 'ET': positionReliable = false; break;
          case 'Tf':
            if(op.args.length === 2 && op.args[0].t === 'name'){ gState.fontName = op.args[0].v; gState.fontSize = op.args[1].v; }
            break;
          case 'Tz': if(op.args.length===1) gState.Th = op.args[0].v; break;
          case 'TL': if(op.args.length===1) gState.TL = op.args[0].v; break;
          case 'Ts': if(op.args.length===1) gState.Ts = op.args[0].v; break;
          case 'Tm':
            if(op.args.length === 6){ Tm = op.args.map(a=>a.v); Tlm = Tm; positionReliable = true; }
            break;
          case 'Td': if(op.args.length === 2) moveTo(op.args[0].v, op.args[1].v); break;
          case 'TD':
            if(op.args.length === 2){ gState.TL = -op.args[1].v; moveTo(op.args[0].v, op.args[1].v); }
            break;
          case 'T*': moveTo(0, -gState.TL); break;
          case 'Tj': case "'": case '"': {
            if(op.name === "'") moveTo(0, -gState.TL);
            else if(op.name === '"'){ moveTo(0, -gState.TL); }
            const strArg = op.args[op.args.length-1];
            if(strArg && strArg.t === 'str'){
              candidates.push({
                kind: 'Tj', op, transform: positionReliable ? currentTransform() : null,
                positionReliable, fontSize: gState.fontSize, fontName: gState.fontName, str: strArg,
              });
            }
            positionReliable = false;
            break;
          }
          case 'TJ': {
            const arr = op.args[0];
            if(arr && arr.t === 'arr'){
              arr.v.forEach((item, idx) => {
                if(item.t === 'str'){
                  candidates.push({
                    kind: 'TJ', op, arrIndex: idx,
                    transform: (idx === 0 && positionReliable) ? currentTransform() : null,
                    positionReliable: idx === 0 && positionReliable,
                    fontSize: gState.fontSize, fontName: gState.fontName, str: item,
                  });
                }
              });
            }
            positionReliable = false;
            break;
          }
          default: break;
        }
      }
      return candidates;
    }

    function isIsolated(candidates, index){
      const c = candidates[index];
      if(!c.positionReliable) return false;
      let next = null;
      for(let i = index + 1; i < candidates.length; i++){
        if(candidates[i].op !== c.op){ next = candidates[i]; break; }
      }
      if(!next) return true;
      return next.positionReliable === true;
    }
    function operatorByteLength(candidates, index){
      const c = candidates[index];
      if(c.kind === 'Tj') return c.str.v.length;
      let total = 0;
      for(const cand of candidates){ if(cand.op === c.op) total += cand.str.v.length; }
      return total;
    }
    function findSafeCandidate(candidates, targetTransform, targetWidth){
      const posTol = 0.5;
      const matches = [];
      for(let i = 0; i < candidates.length; i++){
        const c = candidates[i];
        if(c.transform == null) continue;
        if(c.kind === 'TJ' && c.arrIndex !== 0) continue;
        const close = c.transform.every((v, k) => Math.abs(v - targetTransform[k]) <= posTol);
        if(!close) continue;
        if(!isIsolated(candidates, i)) continue;
        matches.push({ candidate: c, index: i });
      }
      if(matches.length !== 1) return null;
      const { candidate, index } = matches[0];
      if(targetWidth != null && candidate.fontSize){
        const byteLen = operatorByteLength(candidates, index);
        const fs = candidate.fontSize;
        const lowerBound = byteLen * fs * 0.10;
        const upperBound = byteLen * fs * 1.5 + fs;
        if(targetWidth < lowerBound || targetWidth > upperBound) return null;
      }
      return candidate;
    }
    function deleteOperator(bytes, candidate){
      const op = candidate.op;
      const before = bytes.slice(0, op.opStart);
      const after = bytes.slice(op.opEnd);
      const out = new Uint8Array(before.length + after.length);
      out.set(before, 0);
      out.set(after, before.length);
      return out;
    }

    // Collect the page's content stream(s) as {ref, stream} pairs.
    // /Contents may be a single indirect reference or an array of them.
    function collectContentEntries(page, context){
      const contents = page.node.Contents();
      const entries = [];
      function addEntry(refOrStream){
        if(refOrStream instanceof PDFRawStream){
          entries.push({ ref: null, stream: refOrStream });
        } else if(refOrStream){
          const resolved = context.lookup(refOrStream);
          if(resolved instanceof PDFRawStream) entries.push({ ref: refOrStream, stream: resolved });
        }
      }
      if(contents instanceof PDFArray){
        for(let i=0;i<contents.size();i++) addEntry(contents.get(i));
      } else if(contents){
        addEntry(contents);
      }
      return entries;
    }

    // Decode and concatenate all of a page's content stream(s) into one
    // buffer (shared by the true-removal path and the font-extraction path
    // below), tracking where each physical stream's bytes start within the
    // combined buffer so an edit can be mapped back to the right one.
    function getCombinedContentBytes(page, context){
      const entries = collectContentEntries(page, context);
      if(!entries.length) return null;
      const decodedList = entries.map(e => decodePDFRawStream(e.stream).decode());
      const sep = new Uint8Array([0x0a]);
      let totalLen = 0;
      decodedList.forEach((b,i)=>{ totalLen += b.length; if(i < decodedList.length-1) totalLen += sep.length; });
      const combined = new Uint8Array(totalLen);
      const segStarts = [];
      let cursor = 0;
      decodedList.forEach((b,i)=>{
        segStarts.push(cursor);
        combined.set(b, cursor);
        cursor += b.length;
        if(i < decodedList.length-1){ combined.set(sep, cursor); cursor += sep.length; }
      });
      return { entries, decodedList, combined, segStarts };
    }

    // Attempt true (surgical) removal of the text behind a clicked pdf.js
    // text item. Returns true if the page's content stream was mutated
    // in place (via context.assign) and the caller should skip the
    // cover-rectangle step; false if no confident/safe match was found and
    // the caller should proceed with the normal cover-box edit unchanged.
    function attemptTrueTextRemoval(workingDoc, page, item){
      try{
        const context = workingDoc.context;
        const built = getCombinedContentBytes(page, context);
        if(!built) return false;
        const { entries, decodedList, combined, segStarts } = built;

        const candidates = walkTextPositions(combined);
        const match = findSafeCandidate(candidates, item.transform, item.width);
        if(!match) return false;

        const opStart = match.op.opStart, opEnd = match.op.opEnd;
        let segIdx = -1;
        for(let i=segStarts.length-1;i>=0;i--){ if(opStart >= segStarts[i]){ segIdx = i; break; } }
        if(segIdx === -1) return false;
        const localStart = opStart - segStarts[segIdx];
        const localEnd = opEnd - segStarts[segIdx];
        const segBytes = decodedList[segIdx];
        if(localEnd > segBytes.length) return false;

        const entry = entries[segIdx];
        if(!entry.ref) return false; // directly-embedded stream (no ref) — skip, safe fallback

        const localCandidate = { op: { opStart: localStart, opEnd: localEnd } };
        const edited = deleteOperator(segBytes, localCandidate);

        const newStream = PDFRawStream.of(entry.stream.dict, edited);
        newStream.dict.set(PDFName.of('Length'), context.obj(edited.length));
        newStream.dict.delete(PDFName.of('Filter'));
        newStream.dict.delete(PDFName.of('DecodeParms'));
        context.assign(entry.ref, newStream);
        return true;
      }catch(e){
        console.warn('true text removal skipped, using cover-box edit:', e);
        return false;
      }
    }

    // Best-effort: find which font RESOURCE NAME (e.g. "/F1") drew the text
    // at this position, purely to look up its embedded font program. Unlike
    // findSafeCandidate this does not require "isolation" safety — we are
    // only reading metadata here, never mutating anything, so a looser
    // position-only match is fine. Returns null if nothing lines up closely
    // enough (e.g. the text was drawn via an implicit-advance chain with no
    // candidate positioned exactly at the click).
    function findFontNameForPosition(candidates, targetTransform){
      const posTol = 0.5;
      for(const c of candidates){
        if(c.transform == null) continue;
        if(c.kind === 'TJ' && c.arrIndex !== 0) continue;
        const close = c.transform.every((v, k) => Math.abs(v - targetTransform[k]) <= posTol);
        if(close) return c.fontName;
      }
      return null;
    }

    // Walk the PDF's own font-resource structure to find and decode an
    // embedded font PROGRAM (the actual outline data) for a given resource
    // name. Handles both simple fonts (FontDescriptor directly on the font
    // dict) and Type0/composite fonts (FontDescriptor nested under
    // DescendantFonts[0]) — composite is the common case for embedded Thai/
    // CJK fonts. Returns { bytes, key } (key names which of FontFile/
    // FontFile2/FontFile3 held it) or null if the resource can't be found or
    // has no embedded program at all (a document that only references a
    // system font by name, never embedding it, has nothing to extract).
    function extractEmbeddedFontBytes(page, context, fontResourceName){
      try{
        if(!fontResourceName) return null;
        const resources = page.node.Resources();
        if(!resources) return null;
        const fontsDict = resources.lookup(PDFName.of('Font'));
        if(!(fontsDict instanceof PDFDict)) return null;
        const nameKey = PDFName.of(fontResourceName.replace(/^\//, ''));
        const rawEntry = fontsDict.get(nameKey);
        if(!rawEntry) return null;
        const fontDict = context.lookup(rawEntry);
        if(!(fontDict instanceof PDFDict)) return null;
        const subtypeObj = fontDict.get(PDFName.of('Subtype'));
        const subtype = subtypeObj ? subtypeObj.toString() : '';
        let descriptorDict = null;
        if(subtype === '/Type0'){
          const descFonts = context.lookup(fontDict.get(PDFName.of('DescendantFonts')));
          if(!(descFonts instanceof PDFArray) || descFonts.size() === 0) return null;
          const cidFontDict = context.lookup(descFonts.get(0));
          if(!(cidFontDict instanceof PDFDict)) return null;
          descriptorDict = context.lookup(cidFontDict.get(PDFName.of('FontDescriptor')));
        } else {
          descriptorDict = context.lookup(fontDict.get(PDFName.of('FontDescriptor')));
        }
        if(!(descriptorDict instanceof PDFDict)) return null;
        let fileKey = null;
        for(const k of ['FontFile2','FontFile3','FontFile']){
          if(descriptorDict.get(PDFName.of(k))){ fileKey = k; break; }
        }
        if(!fileKey) return null;
        const fileStream = context.lookup(descriptorDict.get(PDFName.of(fileKey)));
        if(!(fileStream instanceof PDFRawStream)) return null;
        const bytes = decodePDFRawStream(fileStream).decode();
        return { bytes, key: fileKey };
      }catch(e){
        return null;
      }
    }

    // Read the /BaseFont name declared for a font resource (e.g.
    // "ABCDEF+THSarabunNew" or "Angsana New") — present even when there's no
    // embedded font program to extract at all (the document just references
    // a system font by name), which makes it useful as a fallback signal for
    // picking the closest built-in font when true extraction isn't possible.
    // Strips the "ABCDEF+" subset-tag prefix PDF generators add when they
    // embed only a subset of a font's glyphs (spec-mandated 6 uppercase
    // letters + "+", not part of the real font name).
    function getBaseFontName(page, context, fontResourceName){
      try{
        if(!fontResourceName) return null;
        const resources = page.node.Resources();
        if(!resources) return null;
        const fontsDict = resources.lookup(PDFName.of('Font'));
        if(!(fontsDict instanceof PDFDict)) return null;
        const nameKey = PDFName.of(fontResourceName.replace(/^\//, ''));
        const rawEntry = fontsDict.get(nameKey);
        if(!rawEntry) return null;
        const fontDict = context.lookup(rawEntry);
        if(!(fontDict instanceof PDFDict)) return null;
        let target = fontDict;
        if((fontDict.get(PDFName.of('Subtype')) || {}).toString() === '/Type0'){
          const descFonts = context.lookup(fontDict.get(PDFName.of('DescendantFonts')));
          if(descFonts instanceof PDFArray && descFonts.size() > 0){
            const cidFontDict = context.lookup(descFonts.get(0));
            if(cidFontDict instanceof PDFDict) target = cidFontDict;
          }
        }
        const baseFontObj = target.get(PDFName.of('BaseFont'));
        if(!baseFontObj) return null;
        let name = baseFontObj.toString().replace(/^\//, '');
        name = name.replace(/^[A-Z]{6}\+/, '');
        name = name.replace(/-\d+$/, ''); // strip trailing internal subset-id suffixes some tools append (e.g. "Foo-9742")
        return name || null;
      }catch(e){
        return null;
      }
    }

    // Best-effort: try to recover the ORIGINAL PDF's own font for the
    // clicked text item, so a replacement can match the source document's
    // look exactly instead of falling back to the app's built-in font list.
    //
    // Full byte-level recovery only succeeds when the source PDF embeds a
    // COMPLETE font program. Most modern PDF generators (Word, LibreOffice,
    // browser print-to-PDF) instead embed a SUBSET containing only the
    // characters actually used on the page, to keep the file small — and
    // that subsetted form is usually not something a general-purpose font
    // parser can read back (missing tables it expects, or for many CFF/
    // Thai-style embeds, a bare-CFF format outside what's supported at all).
    // Verified directly against real subsetted output, not assumed — so
    // `bytes` is expected to come back null often. `baseFontName` is a much
    // weaker but far more available signal (works even with no embedded
    // font at all) that callers can use to pick the closest built-in font
    // by name instead. Callers must always have a working fallback.
    function extractOriginalFontBytes(workingDoc, page, item){
      try{
        const context = workingDoc.context;
        const built = getCombinedContentBytes(page, context);
        if(!built) return null;
        const candidates = walkTextPositions(built.combined);
        const fontName = findFontNameForPosition(candidates, item.transform);
        if(!fontName) return null;
        const extracted = extractEmbeddedFontBytes(page, context, fontName);
        const baseFontName = getBaseFontName(page, context, fontName);
        return { bytes: extracted ? extracted.bytes : null, baseFontName };
      }catch(e){
        return null;
      }
    }

    return { attemptTrueTextRemoval, extractOriginalFontBytes };
  })();
  let activeItem = null, activeDiv = null;
  let insertPos = null; // { x, yBaseline } in PDF page coords — set when the popover is open in "add new text" mode instead of "edit existing text" mode
  let addMode = false;
  let lastFontKey = "sarabun";
  let lastBold = false;
  let lastItalic = false;
  let lastUnderline = false;
  let lastAlign = "left";
  let lastInsertSize = 16;
  let lastInsertColor = "#1a1a1a";

  // Undo/redo history for the quickedit session — a stack of full snapshots
  // ({ bytes, insertedMeta }) taken right before each mutation (edit apply,
  // insert apply, drag-move, and "reset all edits"). Undo restores the most
  // recent snapshot and pushes the current state onto the redo stack; redo
  // does the reverse. Capped so a long editing session can't grow this
  // without bound — each entry holds a full copy of the PDF's bytes.
  const UNDO_LIMIT = 20;
  let undoStack = [];
  let redoStack = [];
  function cloneInsertedMeta(){ return new Map(insertedMeta); }
  function refreshHistoryButtons(){
    if(undoBtn) undoBtn.disabled = undoStack.length === 0;
    if(redoBtn) redoBtn.disabled = redoStack.length === 0;
  }
  function pushUndoSnapshot(){
    if(!workingBytes) return;
    undoStack.push({ bytes: workingBytes.slice(0), insertedMeta: cloneInsertedMeta(), page: currentPage });
    if(undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    refreshHistoryButtons();
  }
  function clearHistory(){
    undoStack = []; redoStack = [];
    refreshHistoryButtons();
  }
  async function restoreSnapshot(snapshot){
    workingBytes = snapshot.bytes.slice(0);
    workingDoc = await PDFDocument.load(workingBytes.slice(0), { ignoreEncryption: true });
    workingDoc.registerFontkit(fontkit);
    qeFontCache = {};
    insertedMeta.clear();
    snapshot.insertedMeta.forEach((v,k)=> insertedMeta.set(k, v));
    currentPage = snapshot.page || currentPage;
    closePopover();
    await renderCurrentPage();
  }

  // Tracks text boxes that started life as a "+ เพิ่มข้อความ" insertion (and
  // are still being tracked — see the edit path below for how an item can
  // drop out of tracking), keyed by the same origin-bucket key used to find
  // the topmost item at a position. Only boxes with an entry here get drag-
  // to-reposition; plain original-document text stays click-to-edit only, so
  // dragging can never accidentally move content the user never explicitly
  // added/touched via this tool.
  const insertedMeta = new Map();
  function originKey(x, y){ return Math.round(x*2) + "," + Math.round(y*2); }
  let suppressNextClick = false; // set right before a drag-release so the click event the browser still fires afterward doesn't also pop the edit popover open

  const _qeFontBytesCache = {};
  function qeFontBytes(key){
    if(_qeFontBytesCache[key]) return _qeFontBytesCache[key];
    const entry = (window.__QE_FONTS || []).find(f => f.key === key);
    if(!entry) return thaiFontBytes();
    const bin = atob(entry.b64);
    const arr = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    _qeFontBytesCache[key] = arr;
    return arr;
  }
  async function getEmbeddedFont(key){
    if(qeFontCache[key]) return qeFontCache[key];
    const font = await workingDoc.embedFont(qeFontBytes(key), { subset: true });
    qeFontCache[key] = font;
    return font;
  }
  // Resolve the actual font key to embed: if the user wants bold, look for a
  // "-bold" sibling entry that shares the same base family; fall back to the
  // regular weight if no bold variant exists for that family.
  function resolveFontKey(baseKey, wantBold){
    if(!wantBold) return baseKey;
    const list = window.__QE_FONTS || [];
    const boldEntry = list.find(f => f.bold && f.base === baseKey);
    return boldEntry ? boldEntry.key : baseKey;
  }
  function populateFontSelect(){
    fontSelect.innerHTML = "";
    const list = (window.__QE_FONTS || []).filter(f => !f.bold);
    list.forEach(f=>{
      const opt = document.createElement("option");
      opt.value = f.key; opt.textContent = f.label;
      fontSelect.appendChild(opt);
    });
    if(!list.length){
      const opt = document.createElement("option");
      opt.value = "sarabun"; opt.textContent = "Sarabun (ค่าเริ่มต้น)";
      fontSelect.appendChild(opt);
    }
  }
  populateFontSelect();

  /* ============================================================
   * MATCHING THE SOURCE DOCUMENT'S OWN FONT
   *
   * Two ways to get replacement text to visually match the original
   * document instead of the app's fixed Thai font list:
   *  1. Best-effort auto-detect: try to pull the ORIGINAL PDF's own
   *     embedded font program for the clicked text and reuse it. This only
   *     works when the source PDF embeds a COMPLETE font (not the
   *     used-characters-only subset that Word/LibreOffice/browsers embed by
   *     default) — see ContentEditor.extractOriginalFontBytes for why.
   *  2. Name matching: when that fails, match the source PDF's declared
   *     font name against the app's own bundled fonts and pre-select the
   *     closest one. Silently unavailable when neither works; the built-in
   *     font list (whatever was last selected) is always the fallback.
   * ============================================================ */
  const fontHintEl = document.getElementById("quickedit-font-hint");
  let originalFontBytes = null;      // reset per popover open; best-effort per-item

  function fontFullySupportsText(font, text){
    try{
      const set = new Set(font.getCharacterSet());
      for(const ch of text){
        if(!set.has(ch.codePointAt(0))) return false;
      }
      return true;
    }catch(e){ return false; }
  }
  function removeSpecialFontOption(value){
    const opt = fontSelect.querySelector('option[value="'+value+'"]');
    if(opt) opt.remove();
  }
  function addSpecialFontOption(value, label){
    removeSpecialFontOption(value);
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = label;
    fontSelect.insertBefore(opt, fontSelect.firstChild);
    fontSelect.value = value;
  }

  // Fires after a popover is already open for `item`; runs in the
  // background and, if successful, adds/selects the "ฟอนต์ต้นฉบับ" option a
  // moment later — never blocks opening the editor. Falls back to Sarabun
  // (the app's only remaining built-in font) when the real font can't be
  // recovered — see the header comment on vendor/quickedit-fonts-data.js for
  // why the other bundled Thai fonts were removed.
  async function tryDetectOriginalFont(item){
    originalFontBytes = null;
    removeSpecialFontOption("__original__");
    if(!workingBytes) return;
    try{
      const tempDoc = await PDFDocument.load(workingBytes.slice(0), { ignoreEncryption: true });
      const tempPage = tempDoc.getPage(currentPage - 1);
      const extracted = ContentEditor.extractOriginalFontBytes(tempDoc, tempPage, item);
      if(!extracted) return;

      if(extracted.bytes){
        try{
          tempDoc.registerFontkit(fontkit);
          const font = await tempDoc.embedFont(extracted.bytes, { subset: true });
          if(typeof font.getCharacterSet !== "function") throw new Error("unusable");
          // Only offer it if the item is STILL the one being edited (user
          // may have already closed/switched popovers by the time this
          // resolves).
          if(activeItem !== item) return;
          originalFontBytes = extracted.bytes;
          addSpecialFontOption("__original__", "ฟอนต์ต้นฉบับ (ตรวจพบอัตโนมัติ)");
          if(fontHintEl) fontHintEl.textContent = "พบฟอนต์จากไฟล์ต้นฉบับ ใช้แทนได้เลย";
          return;
        }catch(e){
          // fall through to the Sarabun fallback below
        }
      }

      // No usable embedded font program recovered — Sarabun is the only
      // other font this app offers, so fall back to it directly (rather
      // than trying to match the source font's name to one of several
      // bundled fonts, since there is no longer a choice to make).
      if(activeItem === item){
        lastFontKey = "sarabun";
        fontSelect.value = "sarabun";
        if(fontHintEl){
          fontHintEl.textContent = extracted.baseFontName
            ? "ไม่พบไฟล์ฟอนต์ต้นฉบับ (" + extracted.baseFontName + ") ใช้ฟอนต์ Sarabun แทนอัตโนมัติ (อาจไม่ตรงกับต้นฉบับ 100%)"
            : "ไม่พบไฟล์ฟอนต์ต้นฉบับ ใช้ฟอนต์ Sarabun แทนอัตโนมัติ (อาจไม่ตรงกับต้นฉบับ 100%)";
        }
      }
    }catch(e){
      originalFontBytes = null;
    }
  }

  // Resolve which pdf-lib font object to draw the replacement text with,
  // honoring the popover's font dropdown: the auto-detected original font,
  // or one of the app's built-in Thai fonts. Always falls back to a built-in
  // font if the preferred choice can't render every character in the new
  // text (or fails to embed at all) — an edit should never end up with
  // missing/tofu glyphs.
  async function resolveEditFont(newText){
    const selectedValue = fontSelect.value;
    const wantBold = !!(boldCheckbox && boldCheckbox.checked);
    let warning = null;

    if(selectedValue === "__original__" && originalFontBytes){
      try{
        const font = await workingDoc.embedFont(originalFontBytes, { subset: true });
        if(fontFullySupportsText(font, newText)) return { font, warning: null };
        warning = "ฟอนต์ต้นฉบับไม่มีตัวอักษรบางตัวในข้อความนี้ ใช้ฟอนต์สำรองแทน";
      }catch(e){ /* fall through to built-in list */ }
    }

    const baseKey = (selectedValue === "__original__" || !selectedValue)
      ? (lastFontKey || "sarabun") : selectedValue;
    lastFontKey = baseKey;
    lastBold = wantBold;
    const fontKey = resolveFontKey(baseKey, wantBold);
    const font = await getEmbeddedFont(fontKey);
    return { font, warning };
  }

  function hexToRgb01(hex){
    const v = parseInt((hex || "#000000").slice(1), 16);
    return { r: ((v>>16)&255)/255, g: ((v>>8)&255)/255, b: (v&255)/255 };
  }
  function rgbToHex(c){
    const h = v => Math.max(0,Math.min(255,Math.round(v*255))).toString(16).padStart(2,"0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  function sampleInkColor(item, bg){
    try{
      const tx = item.transform;
      const fontSize = Math.hypot(tx[2], tx[3]) || 12;
      const x0 = tx[4], y0 = tx[5];
      const width = item.width || fontSize;
      const descent = fontSize*0.28, ascent = fontSize*0.92;
      const pxLeft = Math.max(0, Math.floor((x0-pageOriginX)*pageScale));
      const pxRight = Math.min(canvasEl.width, Math.ceil((x0+width-pageOriginX)*pageScale));
      const pyTop = Math.max(0, Math.floor(canvasEl.height - (y0+ascent-pageOriginY)*pageScale));
      const pyBottom = Math.min(canvasEl.height, Math.ceil(canvasEl.height - (y0-descent-pageOriginY)*pageScale));
      const w = Math.max(1, pxRight-pxLeft), h = Math.max(1, pyBottom-pyTop);
      const data = canvasEl.getContext("2d").getImageData(pxLeft, pyTop, w, h).data;
      const bgR = bg.r*255, bgG = bg.g*255, bgB = bg.b*255;
      const n = data.length/4;
      const dists = new Float32Array(n);
      let maxDist = 0;
      for(let i=0;i<n;i++){
        const r=data[i*4], g=data[i*4+1], b=data[i*4+2];
        const d = Math.abs(r-bgR) + Math.abs(g-bgG) + Math.abs(b-bgB);
        dists[i] = d;
        if(d > maxDist) maxDist = d;
      }
      if(maxDist < 40) return { r:0, g:0, b:0 };
      const threshold = maxDist * 0.75;
      let rSum=0,gSum=0,bSum=0,count=0;
      for(let i=0;i<n;i++){
        if(dists[i] >= threshold){
          rSum += data[i*4]; gSum += data[i*4+1]; bSum += data[i*4+2]; count++;
        }
      }
      if(count === 0) return { r:0, g:0, b:0 };
      return { r:(rSum/count)/255, g:(gSum/count)/255, b:(bSum/count)/255 };
    }catch(e){ return { r:0, g:0, b:0 }; }
  }

  // After several edits, the PDF's content stream still contains the OLD text
  // objects from earlier edits (this tool only paints over them with a filled
  // rectangle, it never truly deletes anything from the file - see the
  // warning note in the UI). pdf.js's text extraction has no idea those old
  // text objects are now covered up, so without this filter every past edit
  // made at the same spot would show up as its own overlapping clickable
  // "ghost" box, even though nothing is visible there anymore.
  //
  // Every edit this tool makes reuses the exact same baseline origin (x, y)
  // as the text it replaced (see applyBtn.onclick below), and pdf.js lists
  // textContent.items in content-stream order, which is paint order - so
  // whichever item at a given origin appears LAST in the array is the one
  // actually drawn on top and visible; any earlier item sharing that same
  // origin is hidden underneath it and should not be clickable.
  function findTopmostItemsByOrigin(items){
    const lastIndexForOrigin = new Map();
    items.forEach((item, i) => {
      if(!item || !item.str || !item.str.trim()) return;
      const tx = item.transform;
      const key = Math.round(tx[4]*2) + "," + Math.round(tx[5]*2); // ~0.5pt bucket
      lastIndexForOrigin.set(key, i);
    });
    return (item, i) => {
      const tx = item.transform;
      const key = Math.round(tx[4]*2) + "," + Math.round(tx[5]*2);
      return lastIndexForOrigin.get(key) === i;
    };
  }

  function setAddMode(on){
    addMode = !!on;
    if(modeEditBtn) modeEditBtn.classList.toggle("active", !addMode);
    if(modeAddBtn) modeAddBtn.classList.toggle("active", addMode);
    if(stageEl) stageEl.classList.toggle("qe-addmode", addMode);
    if(hintEl) hintEl.textContent = addMode ? ADD_HINT : EDIT_HINT;
    if(!addMode) closePopover();
  }

  function resetState(){
    originalBuffer = null; workingDoc = null; workingBytes = null; qeFontCache = {};
    currentPage = 1; numPages = 1;
    textLayerEl.innerHTML = "";
    const ctx = canvasEl.getContext("2d");
    ctx.clearRect(0,0,canvasEl.width,canvasEl.height);
    insertedMeta.clear();
    clearHistory();
    setAddMode(false);
    closePopover();
  }

  function setAlignUI(align){
    if(!alignGroup) return;
    const target = align || "left";
    alignGroup.querySelectorAll(".chip").forEach(b=>{
      b.classList.toggle("active", b.dataset.align === target);
    });
  }
  function getSelectedAlign(){
    const active = alignGroup && alignGroup.querySelector(".chip.active");
    return (active && active.dataset.align) || "left";
  }
  if(alignGroup){
    alignGroup.querySelectorAll(".chip").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        alignGroup.querySelectorAll(".chip").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        updatePreview();
      });
    });
  }

  // Live preview shown on the page itself while the popover is open, so
  // switching alignment (or any other field) shows roughly how the text will
  // sit BEFORE committing with "บันทึก" — no PDF bytes are touched here, this
  // only positions/styles the one CSS overlay box using the browser's own
  // text layout, which is why it's an approximation rather than an exact
  // match for the font pdf-lib will actually embed.
  //
  // Positioning always uses width:auto + a translateX(-50%/-100%) shift for
  // center/right rather than a fixed-width box with text-align: a
  // fixed-width box's text-align is silently ignored by the browser once
  // white-space:pre content overflows that width (confirmed while testing
  // this — text-align:right on an overflowing pre-formatted line rendered
  // as if it were left-aligned), which is exactly the common case here
  // (typed replacement text longer than the original text's own span).
  // translateX shifts by a percentage of the element's own rendered size
  // instead, so it stays correct however much the text overflows.
  //
  // Editing existing text: anchor = the ORIGINAL item's own box span (its
  // left edge, center, or right edge depending on align), matching
  // computeAlignedX()'s refWidth branch.
  // Inserting new text: no box exists yet, so the click/drop point itself
  // already means "this is the text's left/center/right edge" — the same
  // anchor is used for every align value, matching computeAlignedX()'s
  // refWidth===null branch.
  function updatePreview(){
    if(!previewEl) return;
    const editing = !!activeItem, inserting = !!insertPos;
    if(!editing && !inserting || !textarea.value){
      previewEl.hidden = true;
      if(previewMaskEl) previewMaskEl.hidden = true;
      return;
    }
    const size = parseFloat(fontsizeInput.value) || 16;
    // No artificial minimum here — the preview is meant to mirror how big
    // the text will actually look on the page. A floor like "never smaller
    // than 4px" sounds harmless but silently blows up small/dense text (a
    // packed table, a tiny calendar cell): the real glyph might render at
    // 1-2px at this page's zoom level, so clamping the preview to 4px makes
    // it 2-4x bigger than the real thing — exactly the "text jumps huge the
    // instant I click it" bug. Let it go as small as the math says; only
    // guard the degenerate 0-or-negative case (bad/empty input).
    const sizePx = Math.max(0.5, size * pageScale);
    const align = getSelectedAlign();

    previewEl.textContent = textarea.value;
    previewEl.style.color = colorInput.value || "#000000";
    previewEl.style.fontWeight = (boldCheckbox && boldCheckbox.checked) ? "700" : "400";
    previewEl.style.fontStyle = (italicCheckbox && italicCheckbox.checked) ? "italic" : "normal";
    previewEl.style.textDecoration = (underlineCheckbox && underlineCheckbox.checked) ? "underline" : "none";
    previewEl.style.fontSize = sizePx + "px";
    previewEl.style.lineHeight = (sizePx * 1.2) + "px";
    previewEl.style.width = "auto";

    const ascentPx = sizePx * 0.85; // rough ascent estimate, just for vertical placement
    let anchorPdfX, yBaselinePdf;

    if(editing){
      const tx = activeItem.transform;
      const x0 = tx[4]; yBaselinePdf = tx[5];
      const origSize = Math.hypot(tx[2], tx[3]) || size;
      const refWidth = activeItem.width || (origSize * (activeItem.str||"").length * 0.55);
      anchorPdfX = align === "center" ? x0 + refWidth/2 : align === "right" ? x0 + refWidth : x0;

      // Mask always covers the ORIGINAL item's own box (independent of the
      // new text/align being previewed) — generous padding beyond the
      // nominal ascent/descent since this is a cheap synchronous estimate,
      // not the real edit path's pixel-scanned ink extent, and a slightly
      // oversized mask is harmless while a too-small one would leave a
      // sliver of the old glyphs peeking out (the exact ghosting this is
      // meant to prevent).
      if(previewMaskEl){
        const nominalAscent = origSize * 0.92, nominalDescent = origSize * 0.28;
        const maskAscent = nominalAscent * 1.25 + 2, maskDescent = nominalDescent * 1.4 + 2;
        const bg = sampleBgColor(x0, yBaselinePdf, origSize);
        previewMaskEl.style.background = rgbToHex(bg);
        previewMaskEl.style.left = (((x0 - pageOriginX) * pageScale) - 1) + "px";
        previewMaskEl.style.top = (canvasEl.height - (yBaselinePdf + maskAscent - pageOriginY) * pageScale) + "px";
        previewMaskEl.style.width = (refWidth * pageScale + 2) + "px";
        previewMaskEl.style.height = ((maskAscent + maskDescent) * pageScale) + "px";
        previewMaskEl.hidden = false;
      }
    } else {
      anchorPdfX = insertPos.x; yBaselinePdf = insertPos.yBaseline;
      if(previewMaskEl) previewMaskEl.hidden = true; // nothing underneath to cover when inserting new text
    }
    previewEl.style.left = ((anchorPdfX - pageOriginX) * pageScale) + "px";
    previewEl.style.top = (canvasEl.height - (yBaselinePdf - pageOriginY) * pageScale - ascentPx) + "px";
    previewEl.style.transform = align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : "none";
    previewEl.hidden = false;
  }
  [textarea, fontsizeInput].forEach(el=> el && el.addEventListener("input", updatePreview));
  [boldCheckbox, italicCheckbox, underlineCheckbox].forEach(el=> el && el.addEventListener("change", updatePreview));
  if(colorInput) colorInput.addEventListener("input", updatePreview);

  // Floating popover: positioned in the same canvas-pixel space as
  // .qe-box/.qe-preview-box (see the pageScale/pageOriginX/pageOriginY
  // conversions used throughout this module), anchored just below the text
  // being edited (or the click point, when inserting) and clamped so it
  // never runs off the edge of the page. popoverAnchor is kept so a window
  // resize can re-run the same clamp against the new layout instead of
  // leaving the popover stranded off-canvas.
  let popoverAnchor = null;
  function positionPopoverNear(xPdf, yBaselinePdf){
    if(!popover || !canvasEl || popover.hidden) return;
    popoverAnchor = { x: xPdf, yBaseline: yBaselinePdf };
    const margin = 10;
    const anchorLeft = (xPdf - pageOriginX) * pageScale;
    const anchorTop = canvasEl.height - (yBaselinePdf - pageOriginY) * pageScale;
    const pw = popover.offsetWidth || 320, ph = popover.offsetHeight || 200;
    let left = Math.min(Math.max(margin, anchorLeft), Math.max(margin, canvasEl.width - pw - margin));
    let top = anchorTop + margin; // just below the text/click point by default
    if(top + ph > canvasEl.height - margin) top = anchorTop - ph - margin; // no room below — flip above instead
    top = Math.min(Math.max(margin, top), Math.max(margin, canvasEl.height - ph - margin));
    popover.style.left = left + "px";
    popover.style.top = top + "px";
    // The clamp above keeps the popover inside the CANVAS's own pixel
    // bounds, but on a narrow screen the canvas itself is wider than the
    // viewport and .qe-stage-wrap scrolls (overflow:auto) to show only a
    // slice of it — a popover clamped to a valid canvas position can still
    // land outside whatever slice happens to be scrolled into view (e.g.
    // right after scrolling to reveal the clicked text box). Element.
    // scrollIntoView() doesn't reliably fix this here: .qe-stage-wrap
    // centers its (often-wider) content with justify-content:center, and
    // browsers can't scroll to reveal the portion of centered flex content
    // that overflows past the start edge (scrollLeft can't go negative),
    // which is exactly the side the popover tends to overflow on. Instead,
    // measure how far the popover's rendered box sits outside the wrap's
    // visible viewport and nudge scrollLeft/scrollTop by that exact delta.
    const wrapEl = popover.closest(".qe-stage-wrap");
    if(wrapEl){
      const wrapRect = wrapEl.getBoundingClientRect();
      const popRect = popover.getBoundingClientRect();
      const pad = 8;
      let dx = 0, dy = 0;
      if(popRect.left < wrapRect.left + pad) dx = popRect.left - (wrapRect.left + pad);
      else if(popRect.right > wrapRect.right - pad) dx = popRect.right - (wrapRect.right - pad);
      if(popRect.top < wrapRect.top + pad) dy = popRect.top - (wrapRect.top + pad);
      else if(popRect.bottom > wrapRect.bottom - pad) dy = popRect.bottom - (wrapRect.bottom - pad);
      if(dx) wrapEl.scrollLeft += dx;
      if(dy) wrapEl.scrollTop += dy;
    }
  }
  window.addEventListener("resize", ()=>{
    if(popoverAnchor && !popover.hidden) positionPopoverNear(popoverAnchor.x, popoverAnchor.yBaseline);
  });
  // The clamp above is only as good as popover.offsetWidth/offsetHeight at
  // the moment it runs, and right when a popover first opens (hidden ->
  // visible on this same tick) that size can measure narrower than the box
  // actually settles at a couple of frames later — observed ~290px vs the
  // true ~360px max-width — so the initial clamp lets the popover sit
  // further right/down than it should, and nothing ever re-clamps it
  // against the corrected, larger size. Two things paper over this:
  // (1) re-run the clamp after two animation frames, once layout has fully
  // settled, and (2) a ResizeObserver that re-clamps whenever the popover's
  // box size changes afterwards (e.g. the async original-font hint text
  // appearing under the font select).
  function repositionPopoverSoon(){
    requestAnimationFrame(()=>{
      requestAnimationFrame(()=>{
        if(popoverAnchor && !popover.hidden) positionPopoverNear(popoverAnchor.x, popoverAnchor.yBaseline);
      });
    });
  }
  if(popover && typeof ResizeObserver !== "undefined"){
    const popoverResizeObserver = new ResizeObserver(()=>{
      if(popoverAnchor && !popover.hidden) positionPopoverNear(popoverAnchor.x, popoverAnchor.yBaseline);
    });
    popoverResizeObserver.observe(popover);
  }

  function closePopover(){
    if(activeDiv) activeDiv.classList.remove("editing");
    activeItem = null; activeDiv = null; insertPos = null;
    popoverAnchor = null;
    popover.classList.add("qe-sidepanel-empty");
    popover.hidden = true;
    if(previewEl) previewEl.hidden = true;
    if(previewMaskEl) previewMaskEl.hidden = true;
  }

  // Opens the shared popover in "insert new text" mode: no source text item,
  // just a bare position on the page (in PDF coordinate space, y already
  // converted to a text baseline) picked up from a click on the stage while
  // add-mode is active. Reuses every popover field (font, size, bold, color)
  // exactly like editing existing text, minus anything that only makes sense
  // for text that already exists (original-font detection, background/ink
  // color sampling).
  function openInsertPopover(x, yBaseline, evt){
    activeItem = null; activeDiv = null;
    insertPos = { x, yBaseline };
    if(popoverHead) popoverHead.textContent = "เพิ่มข้อความใหม่";
    if(colorLabel) colorLabel.textContent = "สี";
    textarea.value = "";
    fontsizeInput.value = lastInsertSize;
    removeSpecialFontOption("__original__");
    if(fontHintEl) fontHintEl.textContent = "";
    fontSelect.value = lastFontKey;
    if(fontSelect.value !== lastFontKey && fontSelect.options.length) fontSelect.selectedIndex = 0;
    if(boldCheckbox) boldCheckbox.checked = lastBold;
    if(italicCheckbox) italicCheckbox.checked = lastItalic;
    if(underlineCheckbox) underlineCheckbox.checked = lastUnderline;
    setAlignUI(lastAlign);
    colorInput.value = lastInsertColor;
    popover.classList.remove("qe-sidepanel-empty");
    popover.hidden = false;
    positionPopoverNear(x, yBaseline);
    repositionPopoverSoon();
    textarea.focus();
    updatePreview();
  }

  function openPopover(item, div){
    insertPos = null;
    activeItem = item; activeDiv = div;
    div.classList.add("editing");
    if(popoverHead) popoverHead.textContent = "แก้ไขข้อความ";
    if(colorLabel) colorLabel.textContent = "สี (ดูดจากต้นฉบับ)";
    textarea.value = item.str;
    const approxSize = Math.hypot(item.transform[2], item.transform[3]) || 12;
    fontsizeInput.value = Math.round(approxSize*10)/10;
    removeSpecialFontOption("__original__");
    if(fontHintEl) fontHintEl.textContent = "";
    fontSelect.value = lastFontKey;
    if(fontSelect.value !== lastFontKey && fontSelect.options.length) fontSelect.selectedIndex = 0;
    if(boldCheckbox) boldCheckbox.checked = lastBold;
    if(italicCheckbox) italicCheckbox.checked = lastItalic;
    if(underlineCheckbox) underlineCheckbox.checked = lastUnderline;
    setAlignUI(lastAlign);
    tryDetectOriginalFont(item); // best-effort, non-blocking
    const tx0 = item.transform;
    const bg0 = sampleBgColor(tx0[4], tx0[5], approxSize);
    const ink0 = sampleInkColor(item, bg0);
    colorInput.value = rgbToHex(ink0);
    popover.classList.remove("qe-sidepanel-empty");
    popover.hidden = false;
    positionPopoverNear(tx0[4], tx0[5]);
    repositionPopoverSoon();
    textarea.focus();
    textarea.select();
    updatePreview();
  }

  // The fixed ascent/descent multipliers below (0.92 / 0.28) are tuned for
  // plain Latin text, but Thai script routinely stacks a vowel mark AND a
  // tone mark above a single consonant (e.g. "ชื่อ", "ที่", "นี่") which can
  // sit taller than that estimate allows. If the erase rectangle is sized
  // from the estimate alone, those extra-tall marks from the text being
  // replaced can peek out above/below the rectangle and survive into the
  // "erased" result. To catch this we measure how far the actual rendered
  // ink extends (searching a generous but bounded window around the nominal
  // box) and grow the erase rectangle to match whenever it's taller than the
  // estimate - never shrink it below the estimate.
  function measureInkExtent(x0, yBaseline, width, nominalAscent, nominalDescent, bg){
    try{
      // The scan window only needs to be tall enough to catch real ascenders/
      // descenders (tall letters, Thai vowel/tone marks above or below the
      // baseline).
      const maxAscent = nominalAscent * 1.3 + 3;
      const maxDescent = nominalDescent * 1.5 + 3;
      const pxLeft = Math.max(0, Math.floor((x0-pageOriginX)*pageScale) - 1);
      const pxRight = Math.min(canvasEl.width, Math.ceil((x0+width-pageOriginX)*pageScale) + 1);
      const pyTop = Math.max(0, Math.floor(canvasEl.height - (yBaseline+maxAscent-pageOriginY)*pageScale));
      const pyBottom = Math.min(canvasEl.height, Math.ceil(canvasEl.height - (yBaseline-maxDescent-pageOriginY)*pageScale));
      const w = Math.max(1, pxRight-pxLeft), h = Math.max(1, pyBottom-pyTop);
      if(w < 1 || h < 1) return { ascent: nominalAscent, descent: nominalDescent };
      const data = canvasEl.getContext("2d").getImageData(pxLeft, pyTop, w, h).data;
      const bgR = bg.r*255, bgG = bg.g*255, bgB = bg.b*255;
      const rowHasInk = new Array(h);
      for(let row=0; row<h; row++){
        let hasInk = false;
        for(let col=0; col<w; col++){
          const idx = (row*w+col)*4;
          const d = Math.abs(data[idx]-bgR) + Math.abs(data[idx+1]-bgG) + Math.abs(data[idx+2]-bgB);
          if(d > 12){ hasInk = true; break; }
        }
        rowHasInk[row] = hasInk;
      }

      // Rather than taking "the first/last row with any ink anywhere in the
      // window" as the glyph's bounds — which can latch onto an unrelated
      // graphic sitting elsewhere in the window (an icon, a rule line,
      // neighboring text) on a tightly laid-out page — flood-fill outward
      // from a seed row we can be confident actually belongs to THIS glyph:
      // somewhere very close to its own baseline. Expansion stops once it
      // hits a gap of blank rows bigger than a small tolerance (the
      // tolerance still lets it bridge disconnected glyph parts, like a
      // dotted "i" or a Thai tone mark sitting a couple pixels above the
      // body of the character).
      const baseRowAbs = Math.round(canvasEl.height - (yBaseline-pageOriginY)*pageScale);
      const baseRow = baseRowAbs - pyTop;
      const seedRadius = Math.max(2, Math.round(nominalAscent * 0.35 * pageScale));
      let seedRow = -1;
      for(let d=0; d<=seedRadius && seedRow===-1; d++){
        const candidates = d===0 ? [baseRow] : [baseRow-d, baseRow+d];
        for(const r of candidates){
          if(r>=0 && r<h && rowHasInk[r]){ seedRow = r; break; }
        }
      }
      if(seedRow === -1) return { ascent: nominalAscent, descent: nominalDescent };

      const GAP_TOLERANCE = 2;
      function expand(dir){
        let boundary = seedRow, gap = 0, r = seedRow + dir;
        while(r >= 0 && r < h){
          if(rowHasInk[r]){ boundary = r; gap = 0; }
          else if(++gap > GAP_TOLERANCE) break;
          r += dir;
        }
        return boundary;
      }
      const topRow = expand(-1);
      const bottomRow = expand(1);

      // pad a little beyond the detected ink to fully swallow anti-aliased
      // edge pixels that fall just under the threshold
      const topPxAbs = Math.max(0, pyTop + topRow - 2);
      const bottomPxAbs = Math.min(canvasEl.height, pyTop + bottomRow + 1 + 1);
      const topPdfY = (canvasEl.height - topPxAbs) / pageScale + pageOriginY;
      const bottomPdfY = (canvasEl.height - bottomPxAbs) / pageScale + pageOriginY;
      // Trust the ACTUALLY DETECTED ink extent rather than flooring it at the
      // generic nominal font metrics — short glyphs (digits, Thai text with
      // no ascenders/descenders in this particular run) should get a snug
      // background, not one padded out to a tall-letter's worst case. Keep
      // only a small minimum so the box never collapses to a sliver.
      const minSpan = Math.max(1, nominalAscent * 0.12);
      return {
        ascent: Math.max(minSpan, topPdfY - yBaseline),
        descent: Math.max(minSpan, yBaseline - bottomPdfY),
      };
    }catch(e){ return { ascent: nominalAscent, descent: nominalDescent }; }
  }

  function sampleBgColor(xPdf, yBaselinePdf, fontSize){
    try{
      const px = Math.min(Math.max(0, Math.round((xPdf-pageOriginX) * pageScale) - 3), canvasEl.width - 1);
      const py = Math.min(Math.max(0, Math.round(canvasEl.height - (yBaselinePdf + fontSize*0.95 - pageOriginY) * pageScale) - 3), canvasEl.height - 1);
      const data = canvasEl.getContext("2d").getImageData(px, py, 1, 1).data;
      return { r: data[0]/255, g: data[1]/255, b: data[2]/255 };
    }catch(e){ return { r:1, g:1, b:1 }; }
  }

  async function renderCurrentPage(){
    const { canvas, numPages: n, doc: pdfjsDoc, scale } = await renderPageCanvas(workingBytes, currentPage, RENDER_WIDTH);
    numPages = n; pageScale = scale;
    canvasEl.width = canvas.width; canvasEl.height = canvas.height;
    canvasEl.getContext("2d").drawImage(canvas, 0, 0);
    stageEl.style.width = canvas.width + "px";
    stageEl.style.height = canvas.height + "px";

    const page = await pdfjsDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: pageScale });
    pageOriginX = (viewport.viewBox && viewport.viewBox[0]) || 0;
    pageOriginY = (viewport.viewBox && viewport.viewBox[1]) || 0;
    const textContent = await page.getTextContent();

    textLayerEl.innerHTML = "";
    textLayerEl.style.width = canvas.width + "px";
    textLayerEl.style.height = canvas.height + "px";
    const textDivs = [];
    await pdfjsLib.renderTextLayer({ textContent, container: textLayerEl, viewport, textDivs }).promise;

    const isTopmostAtOrigin = findTopmostItemsByOrigin(textContent.items);
    textDivs.forEach((div, i)=>{
      const item = textContent.items[i];
      if(!item || !item.str || !item.str.trim()){ return; }
      if(!isTopmostAtOrigin(item, i)){ return; }
      div.classList.add("qe-box");
      div.addEventListener("click", (e)=>{
        if(suppressNextClick){ suppressNextClick = false; return; }
        e.stopPropagation();
        openPopover(item, div);
      });
      const key = originKey(item.transform[4], item.transform[5]);
      if(insertedMeta.has(key)){
        div.classList.add("qe-box-draggable");
        wireDrag(div, item, key);
      }
    });

    pageIndicator.textContent = `หน้า ${currentPage} / ${numPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= numPages;
  }

  wireDrop(drop, input, async (files)=>{
    setAddMode(false);
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    setFilenameDefault(filenameInput, `${fileName}_edited`);
    body.style.display = "block";
    if(panelEl) panelEl.classList.add("qe-file-loaded");
    setStatus(status, "กำลังเปิดไฟล์...", "loading");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
      workingDoc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      ({ doc: workingDoc, bytes: originalBuffer } = await autoDecryptIfNeeded(workingDoc, originalBuffer));
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      workingBytes = originalBuffer.slice(0);
      currentPage = 1;
      insertedMeta.clear();
      clearHistory();
      await renderCurrentPage();
      setStatus(status, "", "");
    }catch(e){
      // A file that needs a real password (autoDecryptIfNeeded already tried
      // and failed above) leaves the editor body visible but with nothing
      // actually loaded into it (currentPage/renderCurrentPage never ran) —
      // close it back up so the status message isn't paired with a stale,
      // half-open editing panel.
      body.style.display = "none";
      if(panelEl) panelEl.classList.remove("qe-file-loaded");
      setStatus(status, "เปิดไฟล์ไม่สำเร็จ: " + e.message, "err");
    }
  });

  prevBtn.onclick = async ()=>{
    if(currentPage <= 1) return;
    closePopover();
    currentPage -= 1;
    await renderCurrentPage();
  };
  nextBtn.onclick = async ()=>{
    if(currentPage >= numPages) return;
    closePopover();
    currentPage += 1;
    await renderCurrentPage();
  };

  if(modeEditBtn){
    modeEditBtn.onclick = ()=>{ setAddMode(false); };
  }
  if(modeAddBtn){
    modeAddBtn.onclick = ()=>{ setAddMode(true); };
  }
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && addMode) setAddMode(false);
  });
  // Clicking anywhere on the stage while add-mode is on, other than on an
  // existing clickable text box (those stop propagation in their own click
  // handler in renderCurrentPage, so this never fires for them), places a
  // new text box at that point. Converts the click from screen pixels to
  // canvas pixels (the canvas can be displayed at a different CSS size than
  // its backing resolution) and then to PDF page coordinates using the same
  // pageScale used everywhere else in this module; the click's own y becomes
  // the new text's baseline directly, so text is written sitting "on" the
  // spot the user clicked, same as writing on a ruled line.
  stageEl.addEventListener("click", (e)=>{
    if(!addMode || !workingBytes) return;
    if(e.target.closest(".qe-box")) return;
    const rect = canvasEl.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    if(px < 0 || py < 0 || px > canvasEl.width || py > canvasEl.height) return;
    // Must stop propagation before opening: the document-level "click
    // outside the popover closes it" listener further below would otherwise
    // see this SAME click bubble past the popover it just opened and close
    // it again in the same tick (exactly like each .qe-box click handler
    // already has to do for the same reason).
    e.stopPropagation();
    const xPdf = px / pageScale + pageOriginX;
    const yBaselinePdf = (canvasEl.height - py) / pageScale + pageOriginY;
    openInsertPopover(xPdf, yBaselinePdf, e);
  });

  // Measures the widest line of (possibly multi-line) text at a given font
  // size, used to position aligned text (center/right) and to size the
  // underline stroke. pdf-lib's widthOfTextAtSize operates on a single line;
  // splitting first keeps center/right alignment reasonable even for the
  // rare multi-line insert.
  function measureTextWidth(font, text, size){
    const lines = String(text || "").split(/\r\n|\r|\n/);
    let max = 0;
    for(const line of lines){
      const w = font.widthOfTextAtSize(line, size);
      if(w > max) max = w;
    }
    return max;
  }

  // Resolves the actual draw-x for the requested alignment.
  // - refWidth given (editing existing text): align within that box's own
  //   span, exactly like a text box in a word processor — left keeps the
  //   text's original left edge, right keeps its original right edge.
  // - refWidth null (inserting/dragging new text, which has no box): the
  //   anchor IS the point the user clicked/dropped the text at, and align
  //   decides what that point means relative to the text — its left edge,
  //   center, or right edge.
  function computeAlignedX(anchorX, align, textWidth, refWidth){
    if(refWidth == null){
      if(align === "center") return anchorX - textWidth/2;
      if(align === "right") return anchorX - textWidth;
      return anchorX;
    }
    if(align === "center") return anchorX + (refWidth - textWidth)/2;
    if(align === "right") return anchorX + (refWidth - textWidth);
    return anchorX;
  }

  // Draws one text run honoring italic (via pdf-lib's native xSkew — a real
  // oblique transform baked into the PDF, not a CSS-only fake) and underline
  // (a separate thin drawLine spanning the measured text width, since
  // pdf-lib/PDF text itself has no underline flag). Returns the measured
  // width so callers that already need it don't have to measure twice.
  const ITALIC_SKEW_DEGREES = 12;
  function drawStyledText(page, text, opts){
    const width = measureTextWidth(opts.font, text, opts.size);
    const drawOpts = { x: opts.x, y: opts.y, size: opts.size, font: opts.font, color: opts.color };
    if(opts.italic) drawOpts.xSkew = degrees(ITALIC_SKEW_DEGREES);
    page.drawText(text, drawOpts);
    if(opts.underline){
      const thickness = Math.max(0.75, opts.size * 0.06);
      const offset = opts.size * 0.11;
      // Mirror the italic skew in the underline's endpoints too, so it stays
      // flush under slanted text instead of sitting at a fixed horizontal
      // offset that only lines up with upright text.
      const skewPx = opts.italic ? Math.tan(ITALIC_SKEW_DEGREES * Math.PI / 180) * offset : 0;
      page.drawLine({
        start: { x: opts.x + skewPx, y: opts.y - offset },
        end: { x: opts.x + skewPx + width, y: opts.y - offset },
        thickness, color: opts.color,
      });
    }
    return width;
  }

  async function applyInsert(){
    if(!workingDoc || !insertPos) return;
    const pos = insertPos;
    const newText = textarea.value;
    if(newText.trim() === ""){ closePopover(); return; }
    const size = parseFloat(fontsizeInput.value) || 16;
    const italic = !!(italicCheckbox && italicCheckbox.checked);
    const underline = !!(underlineCheckbox && underlineCheckbox.checked);
    const align = getSelectedAlign();
    lastInsertSize = size;
    lastInsertColor = colorInput.value;
    lastItalic = italic; lastUnderline = underline; lastAlign = align;
    closePopover();
    setStatus(status, "กำลังเพิ่มข้อความ...", "loading");
    try{
      pushUndoSnapshot();
      // Same "reload from the latest saved bytes before mutating" rule as the
      // edit path above — see the long comment on applyBtn.onclick below.
      workingDoc = await PDFDocument.load(workingBytes.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      const page = workingDoc.getPage(currentPage - 1);
      const { font, warning } = await resolveEditFont(newText);
      const { r: tr, g: tg, b: tb } = hexToRgb01(lastInsertColor);
      const textWidth = measureTextWidth(font, newText, size);
      // computeAlignedX may shift the glyph's actual left edge away from the
      // clicked anchor (center/right align) — insertedMeta must be keyed by
      // that ACTUAL drawn position, since that's what pdf.js will report as
      // this item's transform[4] on the next render, and hit-testing/drag
      // both look items up by that reported position, not the click point.
      const drawX = computeAlignedX(pos.x, align, textWidth, null);
      drawStyledText(page, newText, { x: drawX, y: pos.yBaseline, size, font, color: rgb(tr, tg, tb), italic, underline });
      workingBytes = await workingDoc.save();
      insertedMeta.set(originKey(drawX, pos.yBaseline), { text: newText, size, fontKey: lastFontKey, bold: lastBold, italic, underline, align, color: lastInsertColor });
      await renderCurrentPage();
      setStatus(status, warning ? ("เพิ่มข้อความแล้ว (" + warning + ")") : "เพิ่มข้อความแล้ว", warning ? "warn" : "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  }

  // Drag-to-reposition — only ever wired onto boxes with an insertedMeta
  // entry (see renderCurrentPage). Uses pointer capture so the drag keeps
  // tracking even if the cursor leaves the small text box while moving.
  // Movement below DRAG_THRESHOLD px is treated as a plain click (handled by
  // the box's own click listener) rather than a drag, so short accidental
  // wiggles between mousedown/mouseup don't move anything.
  const DRAG_THRESHOLD = 4;
  function wireDrag(div, item, key){
    div.style.touchAction = "none";
    div.addEventListener("pointerdown", (e)=>{
      if(e.button !== 0) return;
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const baseTransform = div.style.transform;
      const rect = canvasEl.getBoundingClientRect();
      if(!rect.width || !rect.height) return;
      const scaleX = canvasEl.width / rect.width;
      const scaleY = canvasEl.height / rect.height;
      let dragging = false;
      div.setPointerCapture(e.pointerId);

      function onMove(ev){
        const dxCss = ev.clientX - startX, dyCss = ev.clientY - startY;
        if(!dragging && Math.hypot(dxCss, dyCss) < DRAG_THRESHOLD) return;
        dragging = true;
        div.classList.add("qe-box-dragging");
        div.style.transform = baseTransform + " translate(" + dxCss + "px, " + dyCss + "px)";
      }
      function onUp(ev){
        div.removeEventListener("pointermove", onMove);
        div.removeEventListener("pointerup", onUp);
        div.removeEventListener("pointercancel", onUp);
        div.classList.remove("qe-box-dragging");
        if(!dragging) return; // plain click — let the normal click handler run
        suppressNextClick = true;
        const dxCss = ev.clientX - startX, dyCss = ev.clientY - startY;
        const dxPdf = (dxCss * scaleX) / pageScale;
        const dyPdf = -(dyCss * scaleY) / pageScale; // screen Y grows down, PDF Y grows up
        const pageWidthPdf = canvasEl.width / pageScale, pageHeightPdf = canvasEl.height / pageScale;
        const oldX = item.transform[4], oldY = item.transform[5];
        const newX = Math.max(pageOriginX, Math.min(pageOriginX + pageWidthPdf - 2, oldX + dxPdf));
        const newY = Math.max(pageOriginY, Math.min(pageOriginY + pageHeightPdf - 2, oldY + dyPdf));
        moveInsertedText(key, item, newX, newY);
      }
      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp);
      div.addEventListener("pointercancel", onUp);
    });
  }

  async function moveInsertedText(oldKey, item, newX, newY){
    const meta = insertedMeta.get(oldKey);
    if(!meta || !workingDoc) return;
    insertedMeta.delete(oldKey);
    setStatus(status, "กำลังย้ายข้อความ...", "loading");
    try{
      pushUndoSnapshot();
      // Same reload-fresh-before-mutating rule as every other edit path in
      // this module — see the comment on applyBtn.onclick below.
      workingDoc = await PDFDocument.load(workingBytes.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      const page = workingDoc.getPage(currentPage - 1);
      const trueRemoval = ContentEditor.attemptTrueTextRemoval(workingDoc, page, item);
      if(!trueRemoval){
        const origSize = Math.hypot(item.transform[2], item.transform[3]) || meta.size;
        const width = item.width || (origSize * (item.str||"").length * 0.55);
        const descent = origSize * 0.28, ascent = origSize * 0.92;
        const fill = sampleBgColor(item.transform[4], item.transform[5], origSize);
        const inkExtent = measureInkExtent(item.transform[4], item.transform[5], width, ascent, descent, fill);
        page.drawRectangle({
          x: item.transform[4] - 0.5, y: item.transform[5] - inkExtent.descent,
          width: width + 1, height: inkExtent.descent + inkExtent.ascent,
          color: rgb(fill.r, fill.g, fill.b),
        });
      }
      const fontKey = resolveFontKey(meta.fontKey, meta.bold);
      const font = await getEmbeddedFont(fontKey);
      const { r: tr, g: tg, b: tb } = hexToRgb01(meta.color);
      // A drag translates the already-rendered glyph directly by the mouse
      // delta (newX/newY is that glyph's new left edge/baseline) — it does
      // NOT re-run alignment math. Re-deriving alignment from some "anchor"
      // here would double-apply whatever offset the original align already
      // baked into the glyph's position, so dragging always draws left-
      // anchored at the literal drop point, same as before this feature;
      // only italic/underline styling is new here.
      drawStyledText(page, meta.text, { x: newX, y: newY, size: meta.size, font, color: rgb(tr, tg, tb), italic: !!meta.italic, underline: !!meta.underline });
      workingBytes = await workingDoc.save();
      insertedMeta.set(originKey(newX, newY), meta);
      await renderCurrentPage();
      setStatus(status, "ย้ายข้อความแล้ว", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  }

  applyBtn.onclick = async ()=>{
    if(insertPos){ await applyInsert(); return; }
    if(!activeItem || !workingDoc) return;
    const item = activeItem;
    const newText = textarea.value;
    const size = parseFloat(fontsizeInput.value) || Math.hypot(item.transform[2], item.transform[3]) || 12;
    const italic = !!(italicCheckbox && italicCheckbox.checked);
    const underline = !!(underlineCheckbox && underlineCheckbox.checked);
    const align = getSelectedAlign();
    lastItalic = italic; lastUnderline = underline; lastAlign = align;
    closePopover();
    setStatus(status, "กำลังบันทึกการแก้ไข...", "loading");
    try{
      const tx = item.transform;
      const x = tx[4], yBaseline = tx[5];
      const origSize = Math.hypot(tx[2], tx[3]) || size;
      const width = item.width || (origSize * (item.str||"").length * 0.55);
      const descent = origSize * 0.28;
      const ascent = origSize * 0.92;

      const fill = sampleBgColor(x, yBaseline, origSize);
      const inkExtent = measureInkExtent(x, yBaseline, width, ascent, descent, fill);

      pushUndoSnapshot();
      // Reload a fresh PDFDocument from the latest saved bytes before mutating.
      // pdf-lib silently fails to persist further drawText/drawRectangle calls
      // made against a PDFDocument instance that has already been save()'d once
      // (a second edit on the same long-lived instance does not show up in the
      // output at all) so each edit gets its own freshly-parsed document built
      // from the previous edit's output.
      workingDoc = await PDFDocument.load(workingBytes.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      const page = workingDoc.getPage(currentPage - 1);

      // Try genuine content-stream removal first (no cover box needed — the
      // old glyphs are actually gone, which also looks better on non-flat
      // backgrounds). Falls back to the proven cover-box edit whenever the
      // match isn't unambiguous and provably safe.
      const trueRemoval = ContentEditor.attemptTrueTextRemoval(workingDoc, page, item);
      if(!trueRemoval){
        page.drawRectangle({
          x: x - 0.5, y: yBaseline - inkExtent.descent, width: width + 1, height: inkExtent.descent + inkExtent.ascent,
          color: rgb(fill.r, fill.g, fill.b),
        });
      }
      let fontWarning = null;
      let drawX = x;
      if(newText.trim() !== ""){
        const { font, warning } = await resolveEditFont(newText);
        fontWarning = warning;
        const { r: tr, g: tg, b: tb } = hexToRgb01(colorInput.value);
        // Align within the ORIGINAL text item's own box span (its left edge
        // to left+width) — same idea as aligning text inside a fixed text
        // box, using the box this text already occupied on the page.
        const textWidth = measureTextWidth(font, newText, size);
        drawX = computeAlignedX(x, align, textWidth, width);
        drawStyledText(page, newText, { x: drawX, y: yBaseline, size, font, color: rgb(tr, tg, tb), italic, underline });
      }
      // Keep drag tracking in sync: this edit reuses the same origin, so a
      // box that was already draggable (came from "+ เพิ่มข้อความ", or a
      // previous edit that kept it tracked) stays draggable with its
      // appearance refreshed to match what was just saved — unless the user
      // picked "ฟอนต์ต้นฉบับ" (the auto-detected original-font option),
      // whose raw font bytes aren't kept around for a future drag to reuse;
      // in that one case drop tracking rather than risk redrawing a future
      // drag in the wrong font.
      const editKey = originKey(x, yBaseline);
      if(insertedMeta.has(editKey)){
        insertedMeta.delete(editKey);
        // Re-key by the ACTUAL drawn position (drawX may differ from the old
        // x when center/right-aligned) — pdf.js will report the redrawn
        // glyph's own transform[4] there on the next render, and that's what
        // hit-testing/dragging look items up by.
        if(newText.trim() !== "" && fontSelect.value !== "__original__"){
          insertedMeta.set(originKey(drawX, yBaseline), { text: newText, size, fontKey: lastFontKey, bold: lastBold, italic, underline, align, color: colorInput.value });
        }
      }
      workingBytes = await workingDoc.save();
      await renderCurrentPage();
      setStatus(status, fontWarning ? ("บันทึกการแก้ไขแล้ว (" + fontWarning + ")") : "บันทึกการแก้ไขแล้ว", fontWarning ? "warn" : "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };
  cancelBtn.onclick = closePopover;
  document.addEventListener("click", (e)=>{
    if(!popover.hidden && !popover.contains(e.target) && !e.target.closest(".qe-box")){
      closePopover();
    }
  });
  popover.addEventListener("click", (e)=> e.stopPropagation());

  resetBtn.onclick = async ()=>{
    if(!originalBuffer) return;
    setStatus(status, "กำลังล้างการแก้ไข...", "loading");
    try{
      pushUndoSnapshot(); // so "ล้างการแก้ไข" itself can be undone back to the edited state
      workingDoc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      workingBytes = originalBuffer.slice(0);
      currentPage = 1;
      insertedMeta.clear();
      await renderCurrentPage();
      setStatus(status, "เริ่มใหม่จากไฟล์เดิมแล้ว", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };

  if(undoBtn){
    undoBtn.onclick = async ()=>{
      if(!undoStack.length || !workingBytes) return;
      const snapshot = undoStack.pop();
      redoStack.push({ bytes: workingBytes.slice(0), insertedMeta: cloneInsertedMeta(), page: currentPage });
      refreshHistoryButtons();
      setStatus(status, "กำลังเลิกทำ...", "loading");
      try{
        await restoreSnapshot(snapshot);
        setStatus(status, "เลิกทำแล้ว", "ok");
      }catch(e){
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
    };
  }
  if(redoBtn){
    redoBtn.onclick = async ()=>{
      if(!redoStack.length || !workingBytes) return;
      const snapshot = redoStack.pop();
      undoStack.push({ bytes: workingBytes.slice(0), insertedMeta: cloneInsertedMeta(), page: currentPage });
      refreshHistoryButtons();
      setStatus(status, "กำลังทำซ้ำ...", "loading");
      try{
        await restoreSnapshot(snapshot);
        setStatus(status, "ทำซ้ำแล้ว", "ok");
      }catch(e){
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
    };
  }

  downloadBtn.onclick = ()=>{
    if(!workingBytes) return;
    const blob = new Blob([workingBytes], { type: "application/pdf" });
    downloadBlob(blob, resolveFilename(filenameInput, `${fileName}_edited`, ".pdf"));
  };

  removeBtn.onclick = ()=>{
    resetState();
    body.style.display = "none";
    if(panelEl) panelEl.classList.remove("qe-file-loaded");
    input.value = "";
    setStatus(status, "", "");
  };
})();

/* ================= SIGNATURE ================= */
(function(){
  const drop = document.getElementById("signature-drop");
  const input = document.getElementById("signature-input");
  const body = document.getElementById("signature-body");
  const filenameEl = document.getElementById("signature-filename");
  const removeBtn = document.getElementById("signature-remove");

  const imgInput = document.getElementById("signature-image-input");
  const imgChooseBtn = document.getElementById("signature-image-choose");
  const imgRemoveBtn = document.getElementById("signature-image-remove");
  const imgThumb = document.getElementById("signature-image-thumb");
  const imgTitle = document.getElementById("signature-image-title");
  const imgSub = document.getElementById("signature-image-sub");
  const THUMB_PLACEHOLDER = imgThumb ? imgThumb.innerHTML : "";
  const bgRow = document.getElementById("signature-bgremove-row");
  const bgToggle = document.getElementById("signature-bgremove-toggle");
  const bgHint = document.getElementById("signature-bgremove-hint");
  const BG_HINT_DEFAULT = bgHint ? bgHint.textContent : "";

  const prevBtn = document.getElementById("signature-prev");
  const nextBtn = document.getElementById("signature-next");
  const pageIndicator = document.getElementById("signature-page-indicator");
  const stageEl = document.getElementById("signature-stage");
  const canvasEl = document.getElementById("signature-canvas");
  const overlayEl = document.getElementById("signature-overlay");
  const overlayImg = document.getElementById("signature-overlay-img");
  const handleEl = document.getElementById("signature-handle");

  const addBtn = document.getElementById("signature-add");
  const applyAllBtn = document.getElementById("signature-apply-all");
  const placementsEl = document.getElementById("signature-placements");
  const downloadBtn = document.getElementById("signature-download");
  const filenameInput = document.getElementById("signature-filename-input");
  const resetBtn = document.getElementById("signature-reset");
  const status = document.getElementById("signature-status");
  if(!drop || !input) return;

  const RENDER_WIDTH = 720;
  let originalBuffer = null, fileName = "document";
  let currentPage = 1, numPages = 1, pageScale = 1;
  let sigImageBytes = null, sigImageMime = null, sigImageAspect = 1, sigImageUrl = null;
  let rawImageBytes = null, rawImageMime = null; // the file exactly as uploaded, kept around so the bg-removal toggle can be flipped back and forth without re-uploading
  let placements = [];

  /* ============================================================
   * Automatic light-background removal for signature photos.
   *
   * Most uploaded "signature images" are a phone photo or scan of ink on
   * paper, not a pre-cut transparent PNG — so placed as-is they cover the
   * document with an opaque white/cream rectangle instead of looking like a
   * real signature stamp. This uses a simple, well-established technique for
   * exactly this case (ink is reliably DARKER than its paper, regardless of
   * the paper's exact tint or a photo's color cast): estimate the paper's
   * luminance from a thin strip around the image's own border (signatures
   * are written with margin, so the very edge is almost always background,
   * not ink), then fade every pixel's alpha based on how much darker than
   * that it is — background pixels go fully transparent, ink pixels stay
   * fully opaque, with a soft ramp between the two so stroke edges keep
   * their anti-aliasing instead of turning jagged. Only the alpha channel is
   * touched; ink color (e.g. blue pen, common on Thai official documents) is
   * left exactly as photographed.
   * ============================================================ */
  const BG_REMOVE_MAX_DIM = 1600; // cap resolution before processing — plenty for a stamp-sized image, keeps this fast even for a multi-megapixel phone photo
  const BG_REMOVE_MARGIN = 22;    // luminance units below the estimated paper brightness that still counts as "definitely background"
  const BG_REMOVE_BAND = 55;      // width of the soft transparent->opaque ramp below that

  function loadImageFromBytes(bytes, mime){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const im = new Image();
      im.onload = ()=>{ URL.revokeObjectURL(url); resolve(im); };
      im.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error("ไม่สามารถอ่านรูปภาพนี้ได้")); };
      im.src = url;
    });
  }

  async function autoRemoveLightBackground(bytes, mime){
    const img = await loadImageFromBytes(bytes, mime);
    let w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const scale = Math.min(1, BG_REMOVE_MAX_DIM / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // A source that's already a real cutout (a properly prepared transparent
    // PNG) is left completely untouched rather than re-processed.
    let transparentPixels = 0;
    for(let i = 3; i < data.length; i += 4){ if(data[i] < 250) transparentPixels++; }
    if(transparentPixels / (data.length / 4) > 0.02){
      return { bytes, mime, skipped: true };
    }

    function lumAt(x, y){
      const idx = (y * w + x) * 4;
      return 0.299*data[idx] + 0.587*data[idx+1] + 0.114*data[idx+2];
    }
    const borderLums = [];
    const xStep = Math.max(1, Math.round(w / 200)), yStep = Math.max(1, Math.round(h / 200));
    for(let x = 0; x < w; x += xStep){ borderLums.push(lumAt(x, 0)); borderLums.push(lumAt(x, h-1)); }
    for(let y = 0; y < h; y += yStep){ borderLums.push(lumAt(0, y)); borderLums.push(lumAt(w-1, y)); }
    borderLums.sort((a,b)=>a-b);
    const bgLum = borderLums.length ? borderLums[Math.floor(borderLums.length * 0.5)] : 255;

    const hi = Math.max(0, bgLum - BG_REMOVE_MARGIN);       // at/above this luminance: fully transparent
    const lo = Math.max(0, hi - BG_REMOVE_BAND);            // at/below this luminance: fully opaque
    for(let i = 0; i < data.length; i += 4){
      const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      let alpha;
      if(lum >= hi) alpha = 0;
      else if(lum <= lo) alpha = 255;
      else alpha = Math.round(((hi - lum) / (hi - lo)) * 255);
      data[i+3] = Math.min(data[i+3], alpha); // never make an already-transparent pixel more opaque
    }
    ctx.putImageData(imageData, 0, 0);
    const outBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const outBuf = await outBlob.arrayBuffer();
    return { bytes: new Uint8Array(outBuf), mime: "image/png", skipped: false };
  }

  // Re-derives sigImageBytes/sigImageMime (what actually gets shown on the
  // overlay and embedded into the PDF) from rawImageBytes/rawImageMime,
  // honoring the current state of the background-removal checkbox. Safe to
  // call repeatedly (toggling the checkbox back and forth never needs a
  // re-upload, since the untouched original is always kept in rawImageBytes).
  async function refreshSignatureImage(){
    if(!rawImageBytes) return;
    let result = { bytes: rawImageBytes, mime: rawImageMime, skipped: true };
    if(bgToggle && bgToggle.checked){
      try{
        result = await autoRemoveLightBackground(rawImageBytes, rawImageMime);
      }catch(e){
        if(bgHint) bgHint.textContent = "ตัดพื้นหลังอัตโนมัติไม่สำเร็จ ใช้รูปต้นฉบับแทน";
        result = { bytes: rawImageBytes, mime: rawImageMime, skipped: true };
      }
    }
    sigImageBytes = result.bytes;
    sigImageMime = result.mime;
    if(sigImageUrl) URL.revokeObjectURL(sigImageUrl);
    sigImageUrl = URL.createObjectURL(new Blob([sigImageBytes], { type: sigImageMime }));
    overlayImg.src = sigImageUrl;
    imgThumb.innerHTML = "";
    const thumbImg = document.createElement("img");
    thumbImg.src = sigImageUrl;
    imgThumb.appendChild(thumbImg);
    if(bgHint && bgToggle && bgToggle.checked){
      bgHint.textContent = result.skipped
        ? "ตรวจพบว่ารูปนี้มีพื้นหลังโปร่งใสอยู่แล้ว จึงไม่ได้ปรับเพิ่ม"
        : "ตัดพื้นหลังสีอ่อนออกให้อัตโนมัติแล้ว";
    } else if(bgHint){
      bgHint.textContent = BG_HINT_DEFAULT;
    }
  }

  function renderPlacementsList(){
    placementsEl.innerHTML = "";
    if(!placements.length){
      const empty = document.createElement("div");
      empty.className = "sig-placement-empty";
      empty.textContent = 'ยังไม่มีการวางลายเซ็น — จัดตำแหน่งบนหน้าเอกสารแล้วกด "เพิ่มลายเซ็นในหน้านี้"';
      placementsEl.appendChild(empty);
      return;
    }
    placements.forEach((p, idx)=>{
      const row = document.createElement("div");
      row.className = "sig-placement-item";
      const label = document.createElement("span");
      label.innerHTML = `ลายเซ็นที่ ${idx+1} — <b>หน้า ${p.page}</b>`;
      row.appendChild(label);
      const rm = document.createElement("button");
      rm.className = "btn secondary small";
      rm.textContent = "ลบ";
      rm.onclick = ()=>{ placements.splice(idx,1); renderPlacementsList(); };
      row.appendChild(rm);
      placementsEl.appendChild(row);
    });
  }
  renderPlacementsList();

  function clampOverlay(){
    const maxW = canvasEl.width, maxH = canvasEl.height;
    let w = Math.min(overlayEl.offsetWidth, maxW);
    let h = Math.min(overlayEl.offsetHeight, maxH);
    let left = parseFloat(overlayEl.style.left) || 0;
    let top = parseFloat(overlayEl.style.top) || 0;
    left = Math.max(0, Math.min(left, maxW - w));
    top = Math.max(0, Math.min(top, maxH - h));
    overlayEl.style.width = w + "px"; overlayEl.style.height = h + "px";
    overlayEl.style.left = left + "px"; overlayEl.style.top = top + "px";
  }

  function placeOverlayDefault(){
    const w = Math.min(220, canvasEl.width * 0.36);
    const h = w / (sigImageAspect || 1);
    overlayEl.style.width = w + "px";
    overlayEl.style.height = h + "px";
    overlayEl.style.left = ((canvasEl.width - w) / 2) + "px";
    overlayEl.style.top = Math.max(0, canvasEl.height * 0.72) + "px";
    clampOverlay();
  }

  async function renderCurrentPage(keepOverlay){
    const { canvas, numPages: n, scale } = await renderPageCanvas(originalBuffer, currentPage, RENDER_WIDTH);
    numPages = n; pageScale = scale;
    canvasEl.width = canvas.width; canvasEl.height = canvas.height;
    canvasEl.getContext("2d").drawImage(canvas, 0, 0);
    stageEl.style.width = canvas.width + "px";
    stageEl.style.height = canvas.height + "px";
    pageIndicator.textContent = `หน้า ${currentPage} / ${numPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= numPages;
    if(sigImageBytes){
      overlayEl.classList.remove("hidden");
      if(keepOverlay) clampOverlay(); else placeOverlayDefault();
    } else {
      overlayEl.classList.add("hidden");
    }
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    setFilenameDefault(filenameInput, `${fileName}_signed`);
    body.style.display = "block";
    setStatus(status, "กำลังเปิดไฟล์...", "loading");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
      currentPage = 1;
      placements = []; renderPlacementsList();
      await renderCurrentPage(false);
      setStatus(status, "", "");
    }catch(e){
      // Same reasoning as the ROTATE menu: this page needs pdf.js to render
      // the page before the "apply signature" step (where autoDecryptIfNeeded
      // runs) is ever reached, so a real-password file fails here first as a
      // PasswordException. Show the same friendly guidance instead of the
      // raw pdf.js message, and close the editor body back up so the user
      // isn't left staring at an empty/stale signing stage.
      body.style.display = "none";
      if(e && e.name === "PasswordException"){
        setStatus(status, 'ไฟล์นี้ตั้งรหัสผ่านสำหรับเปิดไฟล์ไว้จริง (ไม่ใช่แค่ป้องกันการแก้ไข) เมนูนี้ปลดล็อกให้อัตโนมัติไม่ได้ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อใส่รหัสผ่านที่ถูกต้องก่อน แล้วนำไฟล์ที่ปลดล็อกแล้วมาใช้งานเมนูนี้อีกครั้ง', "err");
      } else {
        setStatus(status, "เปิดไฟล์ไม่สำเร็จ: " + e.message, "err");
      }
    }
  });

  prevBtn.onclick = async ()=>{ if(currentPage<=1) return; currentPage--; await renderCurrentPage(true); };
  nextBtn.onclick = async ()=>{ if(currentPage>=numPages) return; currentPage++; await renderCurrentPage(true); };

  removeBtn.onclick = ()=>{
    originalBuffer = null;
    body.style.display = "none";
    input.value = "";
    placements = []; renderPlacementsList();
    overlayEl.classList.add("hidden");
    setStatus(status, "", "");
  };

  /* signature image upload */
  imgChooseBtn.onclick = ()=> imgInput.click();
  imgInput.addEventListener("change", async ()=>{
    if(!imgInput.files.length) return;
    const file = imgInput.files[0];
    try{
      const buf = await readFileAsArrayBuffer(file);
      rawImageBytes = new Uint8Array(buf);
      rawImageMime = (file.type === "image/jpeg" || file.type === "image/jpg") ? "image/jpeg" : "image/png";
      const dim = await new Promise((resolve, reject)=>{
        const im = new Image();
        const tmpUrl = URL.createObjectURL(new Blob([buf], { type: rawImageMime }));
        im.onload = ()=>{ URL.revokeObjectURL(tmpUrl); resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }); };
        im.onerror = ()=>{ URL.revokeObjectURL(tmpUrl); reject(new Error("ไม่สามารถอ่านรูปภาพนี้ได้")); };
        im.src = tmpUrl;
      });
      sigImageAspect = dim.w / dim.h || 1;
      imgTitle.textContent = file.name;
      imgSub.textContent = `${dim.w}×${dim.h}px · ${fmtBytes(file.size)}`;
      imgChooseBtn.textContent = "เปลี่ยนรูป";
      // Before a file is picked, "เลือกรูป" is the one thing the user must
      // do to get started, so it gets the bold primary button style (see
      // index.html) to stand out — testing showed some users missing it as
      // a plain secondary button blending into the card. Once an image is
      // set, the primary action shifts to placing/dragging it on the page,
      // so this drops back to a secondary (lower-emphasis) button.
      imgChooseBtn.classList.add("secondary");
      imgRemoveBtn.style.display = "inline-flex";
      if(bgRow) bgRow.style.display = "flex";
      if(bgToggle) bgToggle.checked = true;
      setStatus(status, "กำลังตัดพื้นหลังอัตโนมัติ...", "loading");
      await refreshSignatureImage();
      if(originalBuffer){
        overlayEl.classList.remove("hidden");
        placeOverlayDefault();
      }
      setStatus(status, "", "");
    }catch(e){
      setStatus(status, "อัปโหลดรูปลายเซ็นไม่สำเร็จ: " + e.message, "err");
    }
  });
  if(bgToggle){
    bgToggle.addEventListener("change", async ()=>{
      setStatus(status, "กำลังปรับพื้นหลัง...", "loading");
      await refreshSignatureImage();
      setStatus(status, "", "");
    });
  }
  imgRemoveBtn.onclick = ()=>{
    sigImageBytes = null; sigImageMime = null;
    rawImageBytes = null; rawImageMime = null;
    if(sigImageUrl){ URL.revokeObjectURL(sigImageUrl); sigImageUrl = null; }
    overlayImg.removeAttribute("src");
    imgThumb.innerHTML = THUMB_PLACEHOLDER;
    imgTitle.textContent = "ยังไม่ได้เลือกรูปลายเซ็น";
    imgSub.textContent = "แนะนำไฟล์ PNG พื้นหลังโปร่งใส";
    imgChooseBtn.textContent = "เลือกรูป";
    imgChooseBtn.classList.remove("secondary"); // back to the bold primary style — see the matching comment above
    imgRemoveBtn.style.display = "none";
    if(bgRow) bgRow.style.display = "none";
    if(bgToggle) bgToggle.checked = true;
    if(bgHint) bgHint.textContent = BG_HINT_DEFAULT;
    imgInput.value = "";
    overlayEl.classList.add("hidden");
  };

  /* drag + resize overlay (pointer events cover mouse + touch) */
  let dragState = null;
  overlayEl.addEventListener("pointerdown", (e)=>{
    if(e.target === handleEl) return;
    e.preventDefault();
    overlayEl.setPointerCapture(e.pointerId);
    dragState = {
      mode: "move", pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(overlayEl.style.left) || 0, startTop: parseFloat(overlayEl.style.top) || 0,
    };
  });
  handleEl.addEventListener("pointerdown", (e)=>{
    e.preventDefault(); e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);
    dragState = {
      mode: "resize", pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      startW: overlayEl.offsetWidth, startH: overlayEl.offsetHeight,
    };
  });
  function onPointerMove(e){
    if(!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if(dragState.mode === "move"){
      let left = dragState.startLeft + dx, top = dragState.startTop + dy;
      const maxW = canvasEl.width, maxH = canvasEl.height;
      left = Math.max(0, Math.min(left, maxW - overlayEl.offsetWidth));
      top = Math.max(0, Math.min(top, maxH - overlayEl.offsetHeight));
      overlayEl.style.left = left + "px"; overlayEl.style.top = top + "px";
    } else if(dragState.mode === "resize"){
      let newW = Math.max(30, dragState.startW + dx);
      const curLeft = parseFloat(overlayEl.style.left) || 0;
      const curTop = parseFloat(overlayEl.style.top) || 0;
      newW = Math.min(newW, canvasEl.width - curLeft);
      let newH = newW / (sigImageAspect || 1);
      const maxH = canvasEl.height - curTop;
      if(newH > maxH){ newH = maxH; newW = newH * (sigImageAspect || 1); }
      overlayEl.style.width = newW + "px";
      overlayEl.style.height = newH + "px";
    }
  }
  function onPointerUp(e){
    if(!dragState || e.pointerId !== dragState.pointerId) return;
    dragState = null;
  }
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);

  addBtn.onclick = ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!sigImageBytes){ setStatus(status, "กรุณาอัปโหลดรูปลายเซ็นก่อน", "err"); return; }
    const pxLeft = parseFloat(overlayEl.style.left) || 0;
    const pxTop = parseFloat(overlayEl.style.top) || 0;
    const pxW = overlayEl.offsetWidth, pxH = overlayEl.offsetHeight;
    const pageHeightPt = canvasEl.height / pageScale;
    const pdfX = pxLeft / pageScale;
    const pdfW = pxW / pageScale;
    const pdfH = pxH / pageScale;
    const pdfYFromTop = pxTop / pageScale;
    const pdfY = pageHeightPt - pdfYFromTop - pdfH;
    placements.push({ page: currentPage, x: pdfX, y: pdfY, width: pdfW, height: pdfH });
    renderPlacementsList();
    setStatus(status, `เพิ่มลายเซ็นในหน้า ${currentPage} แล้ว`, "ok");
  };

  // "ใช้ตำแหน่งนี้กับทุกหน้า" — takes the overlay's current position/size on the
  // page being viewed, expresses it as a FRACTION of that page's own canvas
  // (not raw pixels), then re-applies that same fraction to every page in the
  // document using each page's own real point-size from pdf-lib. Using a
  // fraction (not a fixed point offset) keeps the signature positioned
  // consistently even if some pages happen to have different dimensions
  // (e.g. a stray landscape page mixed into an otherwise portrait document).
  // This replaces whatever placements already existed, since the whole point
  // of the button is "sign the same spot on every page" in one action.
  applyAllBtn.onclick = async ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!sigImageBytes){ setStatus(status, "กรุณาอัปโหลดรูปลายเซ็นก่อน", "err"); return; }
    const pxLeft = parseFloat(overlayEl.style.left) || 0;
    const pxTop = parseFloat(overlayEl.style.top) || 0;
    const pxW = overlayEl.offsetWidth, pxH = overlayEl.offsetHeight;
    const fracLeft = pxLeft / canvasEl.width;
    const fracTop = pxTop / canvasEl.height;
    const fracW = pxW / canvasEl.width;
    const fracH = pxH / canvasEl.height;
    setStatus(status, "กำลังใช้ตำแหน่งนี้กับทุกหน้า...", "loading");
    try{
      let doc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      ({ doc } = await autoDecryptIfNeeded(doc, originalBuffer));
      const total = doc.getPageCount();
      const prevCount = placements.length;
      placements = [];
      for(let i = 0; i < total; i++){
        const { width: pw, height: ph } = doc.getPage(i).getSize();
        const pdfW = fracW * pw;
        const pdfH = fracH * ph;
        const pdfX = fracLeft * pw;
        const pdfYFromTop = fracTop * ph;
        const pdfY = ph - pdfYFromTop - pdfH;
        placements.push({ page: i + 1, x: pdfX, y: pdfY, width: pdfW, height: pdfH });
      }
      renderPlacementsList();
      const replacedNote = prevCount ? ` (แทนที่ตำแหน่งเดิม ${prevCount} ตำแหน่ง)` : "";
      setStatus(status, `เพิ่มลายเซ็นในทุกหน้าแล้ว (${total} หน้า)${replacedNote}`, "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };

  downloadBtn.onclick = async ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!sigImageBytes){ setStatus(status, "กรุณาอัปโหลดรูปลายเซ็นก่อน", "err"); return; }
    if(!placements.length){ setStatus(status, "กรุณาเพิ่มลายเซ็นลงในหน้าอย่างน้อย 1 ตำแหน่งก่อน", "err"); return; }
    setStatus(status, "กำลังสร้างไฟล์...", "loading");
    try{
      let doc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      ({ doc } = await autoDecryptIfNeeded(doc, originalBuffer));
      const img = sigImageMime === "image/jpeg" ? await doc.embedJpg(sigImageBytes) : await doc.embedPng(sigImageBytes);
      placements.forEach(p=>{
        const page = doc.getPage(p.page - 1);
        page.drawImage(img, { x: p.x, y: p.y, width: p.width, height: p.height });
      });
      const bytes = await doc.save();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), resolveFilename(filenameInput, `${fileName}_signed`, ".pdf"));
      setStatus(status, "ดาวน์โหลดไฟล์ที่ลงลายเซ็นแล้ว", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };

  resetBtn.onclick = ()=>{
    placements = [];
    renderPlacementsList();
    setStatus(status, "ล้างลายเซ็นทั้งหมดแล้ว", "ok");
  };
})();

/* ================= SET PASSWORD ================= */
(function(){
  const drop = document.getElementById("setpass-drop");
  const input = document.getElementById("setpass-input");
  const body = document.getElementById("setpass-body");
  const filenameEl = document.getElementById("setpass-filename");
  const removeBtn = document.getElementById("setpass-remove");
  const userpassInput = document.getElementById("setpass-userpass");
  const userpassConfirm = document.getElementById("setpass-userpass-confirm");
  const ownerpassInput = document.getElementById("setpass-ownerpass");
  const allowPrint = document.getElementById("setpass-allow-print");
  const allowCopy = document.getElementById("setpass-allow-copy");
  const allowModify = document.getElementById("setpass-allow-modify");
  const algoSelect = document.getElementById("setpass-algo");
  const runBtn = document.getElementById("setpass-run");
  const status = document.getElementById("setpass-status");
  const result = document.getElementById("setpass-result");
  const downloadBtn = document.getElementById("setpass-download");
  const filenameInput = document.getElementById("setpass-filename-input");
  if(!drop || !input) return;

  let originalBuffer = null, fileName = "document";
  let outputBlob = null;

  document.querySelectorAll(".pw-toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const target = document.getElementById(btn.dataset.target);
      if(!target) return;
      const willShow = target.type === "password";
      target.type = willShow ? "text" : "password";
      btn.setAttribute("aria-pressed", willShow ? "true" : "false");
    });
  });

  function resetOutput(){
    outputBlob = null;
    result.classList.remove("show");
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    resetOutput();
    setStatus(status, "", "");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
    }catch(e){
      setStatus(status, "เปิดไฟล์ไม่สำเร็จ: " + e.message, "err");
    }
  });

  removeBtn.onclick = ()=>{
    originalBuffer = null;
    resetOutput();
    body.style.display = "none";
    input.value = "";
    userpassInput.value = ""; userpassConfirm.value = ""; ownerpassInput.value = "";
    setStatus(status, "", "");
  };

  runBtn.onclick = async ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!window.PDFEncrypt){ setStatus(status, "โหลดไลบรารีเข้ารหัสไม่สำเร็จ ลองรีเฟรชหน้าเว็บ", "err"); return; }
    const userPass = userpassInput.value;
    const confirmPass = userpassConfirm.value;
    const ownerPass = ownerpassInput.value;
    if(userPass !== confirmPass){
      setStatus(status, "รหัสผ่านสำหรับเปิดไฟล์ทั้งสองช่องไม่ตรงกัน", "err");
      return;
    }
    if(!userPass && !ownerPass){
      setStatus(status, "กรุณาตั้งรหัสผ่านอย่างน้อย 1 ช่อง (รหัสผ่านเปิดไฟล์ หรือรหัสผ่านผู้ดูแล)", "err");
      return;
    }
    setStatus(status, "กำลังเข้ารหัสไฟล์...", "loading");
    resetOutput();
    try{
      const opts = {
        algorithm: algoSelect.value,
        allowPrinting: allowPrint.checked,
        allowCopying: allowCopy.checked,
        allowModifying: allowModify.checked,
      };
      if(ownerPass) opts.ownerPassword = ownerPass;
      const srcBytes = new Uint8Array(originalBuffer.slice(0));
      const encBytes = await PDFEncrypt.encryptPDF(srcBytes, userPass, opts);
      outputBlob = new Blob([encBytes], { type: "application/pdf" });
      const algoLabel = opts.algorithm === "RC4" ? "RC4 128-bit" : "AES-256";
      result.querySelector(".stats").innerHTML = `ไฟล์ขนาด <b>${fmtBytes(outputBlob.size)}</b> — เข้ารหัสด้วย <b>${algoLabel}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_protected`);
      result.classList.add("show");
      setStatus(status, "ใส่รหัสผ่านเรียบร้อยแล้ว", "ok");
      userpassInput.value = ""; userpassConfirm.value = ""; ownerpassInput.value = ""; // clear passwords from inputs once no longer needed
    }catch(e){
      if(window.PDFEncrypt && e instanceof PDFEncrypt.AlreadyEncryptedError){
        setStatus(status, "ไฟล์นี้มีรหัสผ่าน/การเข้ารหัสอยู่แล้ว กรุณาปลดรหัสผ่านเดิมก่อนแล้วลองใหม่", "err");
      } else if(window.PDFEncrypt && e instanceof PDFEncrypt.PasswordEncodingError){
        setStatus(status, "รหัสผ่านมีตัวอักษรที่ไม่รองรับ กรุณาลองใหม่ด้วยรหัสผ่านอื่น", "err");
      } else {
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
    }
  };

  downloadBtn.onclick = ()=>{
    if(!outputBlob) return;
    downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_protected`, ".pdf"));
  };
})();

/* ================= REMOVE PASSWORD (unlock) ================= */
(function(){
  const drop = document.getElementById("removepass-drop");
  const input = document.getElementById("removepass-input");
  const body = document.getElementById("removepass-body");
  const filenameEl = document.getElementById("removepass-filename");
  const removeBtn = document.getElementById("removepass-remove");
  const passwordInput = document.getElementById("removepass-password");
  const runBtn = document.getElementById("removepass-run");
  const status = document.getElementById("removepass-status");
  const result = document.getElementById("removepass-result");
  const downloadBtn = document.getElementById("removepass-download");
  const filenameInput = document.getElementById("removepass-filename-input");
  if(!drop || !input) return;

  let originalBuffer = null, fileName = "document";
  let outputBlob = null;

  function resetOutput(){
    outputBlob = null;
    result.classList.remove("show");
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    resetOutput();
    setStatus(status, "", "");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
    }catch(e){
      setStatus(status, "เปิดไฟล์ไม่สำเร็จ: " + e.message, "err");
    }
  });

  removeBtn.onclick = ()=>{
    originalBuffer = null;
    resetOutput();
    body.style.display = "none";
    input.value = "";
    passwordInput.value = "";
    setStatus(status, "", "");
  };

  runBtn.onclick = async ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!window.PDFDecrypt){ setStatus(status, "โหลดไลบรารีปลดล็อกไม่สำเร็จ ลองรีเฟรชหน้าเว็บ", "err"); return; }
    const password = passwordInput.value;
    setStatus(status, "กำลังปลดล็อกไฟล์...", "loading");
    resetOutput();
    try{
      const srcBytes = new Uint8Array(originalBuffer.slice(0));
      const decBytes = await PDFDecrypt.decryptPDF(srcBytes, password);
      outputBlob = new Blob([decBytes], { type: "application/pdf" });
      result.querySelector(".stats").innerHTML = `ไฟล์ขนาด <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_unlocked`);
      result.classList.add("show");
      setStatus(status, "ปลดล็อกไฟล์สำเร็จ", "ok");
      passwordInput.value = ""; // clear password from screen once no longer needed
    }catch(e){
      const msg = (e && e.message) || "";
      if(/incorrect password/i.test(msg)){
        setStatus(status, "รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง", "err");
      } else if(/not encrypted/i.test(msg)){
        setStatus(status, "ไฟล์นี้ไม่ได้ตั้งรหัสผ่าน/เข้ารหัสไว้ตั้งแต่แรก ไม่จำเป็นต้องปลดล็อก", "err");
      } else if(/unsupported encryption/i.test(msg)){
        setStatus(status, "ไฟล์นี้เข้ารหัสด้วยวิธีที่เมนูนี้ยังไม่รองรับ (รองรับเฉพาะ RC4 และ AES-256)", "err");
      } else {
        setStatus(status, "เกิดข้อผิดพลาด: " + msg, "err");
      }
    }
  };

  downloadBtn.onclick = ()=>{
    if(!outputBlob) return;
    downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_unlocked`, ".pdf"));
  };
})();

/* ================= ROTATE ================= */
(function(){
  const drop = document.getElementById("rotate-drop");
  const input = document.getElementById("rotate-input");
  const body = document.getElementById("rotate-body");
  const grid = document.getElementById("rotate-grid");
  const rangeInput = document.getElementById("rotate-range");
  const allBtn = document.getElementById("rotate-all");
  const noneBtn = document.getElementById("rotate-none");
  const leftBtn = document.getElementById("rotate-left");
  const rightBtn = document.getElementById("rotate-right");
  const btn180 = document.getElementById("rotate-180");
  const resetBtn = document.getElementById("rotate-reset");
  const runBtn = document.getElementById("rotate-run");
  const status = document.getElementById("rotate-status");
  const result = document.getElementById("rotate-result");
  const downloadBtn = document.getElementById("rotate-download");
  const filenameEl = document.getElementById("rotate-filename");
  const filenameInput = document.getElementById("rotate-filename-input");
  const removeBtn = document.getElementById("rotate-remove");
  let buffer = null, fileName = "document", numPages = 0, selected = new Set();
  let deltas = []; // per-page additional rotation (1-indexed, index 0 unused)
  let outputBlob = null;

  function normDeg(d){ return ((d % 360) + 360) % 360; }

  function applyCellTransform(i){
    const cell = grid.children[i-1];
    if(!cell) return;
    const canvas = cell.querySelector("canvas");
    if(canvas) canvas.style.transform = deltas[i] ? `rotate(${deltas[i]}deg)` : "";
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    setStatus(status, "กำลังโหลดหน้าเอกสาร...", "loading");
    body.style.display = "block";
    grid.innerHTML = "";
    result.classList.remove("show");
    outputBlob = null;
    try{
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      numPages = pdfjsDoc.numPages;
      deltas = new Array(numPages+1).fill(0);
      selected = new Set(Array.from({length:numPages}, (_,i)=>i+1));
      for(let i=1;i<=numPages;i++){
        const page = await pdfjsDoc.getPage(i);
        const viewport = page.getViewport({ scale: 70 / page.getViewport({scale:1}).width });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.transition = "transform .15s";
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const cell = document.createElement("div");
        cell.className = "pagecell sel";
        cell.style.overflow = "hidden";
        cell.appendChild(canvas);
        const num = document.createElement("div");
        num.className = "num"; num.textContent = i;
        cell.appendChild(num);
        cell.onclick = ()=>{
          if(selected.has(i)) selected.delete(i); else selected.add(i);
          cell.classList.toggle("sel");
          rangeInput.value = rangesToString(Array.from(selected));
        };
        grid.appendChild(cell);
      }
      rangeInput.value = `1-${numPages}`;
      runBtn.disabled = false;
      setStatus(status, `โหลดสำเร็จ · ทั้งหมด ${numPages} หน้า`, "ok");
    }catch(e){
      // This menu needs pdf.js to render the page grid before the user can do
      // anything, so a file with a real open/user password fails right here —
      // long before it would ever reach autoDecryptIfNeeded() inside the run
      // button. pdf.js surfaces that specific case as a PasswordException
      // (whether it's asking for a password or was given a wrong one), so we
      // catch it by name (not by message text, which isn't guaranteed stable)
      // and show the same friendly guidance every other menu shows, instead
      // of a raw/English pdf.js error.
      if(e && e.name === "PasswordException"){
        setStatus(status, 'ไฟล์นี้ตั้งรหัสผ่านสำหรับเปิดไฟล์ไว้จริง (ไม่ใช่แค่ป้องกันการแก้ไข) เมนูนี้ปลดล็อกให้อัตโนมัติไม่ได้ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อใส่รหัสผ่านที่ถูกต้องก่อน แล้วนำไฟล์ที่ปลดล็อกแล้วมาใช้งานเมนูนี้อีกครั้ง', "err");
      } else {
        setStatus(status, "ไม่สามารถอ่านไฟล์นี้ได้: " + e.message, "err");
      }
    }
  });

  function syncGridFromRange(){
    selected = new Set(parseRanges(rangeInput.value, numPages));
    Array.from(grid.children).forEach((cell, i)=> cell.classList.toggle("sel", selected.has(i+1)));
  }
  rangeInput.addEventListener("input", syncGridFromRange);
  allBtn.onclick = ()=>{ rangeInput.value = numPages ? `1-${numPages}` : ""; syncGridFromRange(); };
  noneBtn.onclick = ()=>{ rangeInput.value = ""; syncGridFromRange(); };

  function rotateSelected(amount){
    if(!numPages) return;
    const targets = selected.size ? selected : new Set(Array.from({length:numPages}, (_,i)=>i+1));
    targets.forEach(i=>{
      deltas[i] = normDeg((deltas[i]||0) + amount);
      applyCellTransform(i);
    });
  }
  leftBtn.onclick = ()=> rotateSelected(-90);
  rightBtn.onclick = ()=> rotateSelected(90);
  btn180.onclick = ()=> rotateSelected(180);
  resetBtn.onclick = ()=>{
    if(!numPages) return;
    const targets = selected.size ? selected : new Set(Array.from({length:numPages}, (_,i)=>i+1));
    targets.forEach(i=>{ deltas[i] = 0; applyCellTransform(i); });
  };

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    setStatus(status, "กำลังบันทึกไฟล์...", "loading");
    try{
      let doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc } = await autoDecryptIfNeeded(doc, buffer));
      const pages = doc.getPages();
      let changed = 0;
      pages.forEach((page, idx)=>{
        const i = idx+1;
        const delta = deltas[i] || 0;
        if(delta){
          const current = page.getRotation().angle || 0;
          page.setRotation(degrees(normDeg(current + delta)));
          changed++;
        }
      });
      const bytes = await doc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `หมุนแล้ว <b>${changed}</b> จาก <b>${pages.length}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_rotated`);
      result.classList.add("show");
      setStatus(status, "สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = false;
  };
  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; numPages = 0; selected = new Set(); deltas = [];
    grid.innerHTML = ""; rangeInput.value = "";
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    runBtn.disabled = true;
    setStatus(status, "", "");
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_rotated`, ".pdf")); };
})();

/* ================= REORDER PAGES ================= */
(function(){
  const drop = document.getElementById("reorder-drop");
  const input = document.getElementById("reorder-input");
  const body = document.getElementById("reorder-body");
  const grid = document.getElementById("reorder-grid");
  const resetBtn = document.getElementById("reorder-reset");
  const runBtn = document.getElementById("reorder-run");
  const status = document.getElementById("reorder-status");
  const result = document.getElementById("reorder-result");
  const downloadBtn = document.getElementById("reorder-download");
  const filenameEl = document.getElementById("reorder-filename");
  const filenameInput = document.getElementById("reorder-filename-input");
  const removeBtn = document.getElementById("reorder-remove");
  if(!drop || !input) return;

  let buffer = null, fileName = "document", numPages = 0;
  let thumbCanvases = []; // 1-indexed, keyed by ORIGINAL page number — rendered once, cloned on every re-layout
  let order = [];         // order[i] = original page number now sitting at position i
  let dragSrcIdx = null;
  let outputBlob = null;

  function renderGrid(){
    grid.innerHTML = "";
    order.forEach((origPage, idx)=>{
      const cell = document.createElement("div");
      cell.className = "pagecell reorder-cell";
      cell.draggable = true;

      const src = thumbCanvases[origPage];
      const canvas = document.createElement("canvas");
      canvas.width = src.width; canvas.height = src.height;
      canvas.getContext("2d").drawImage(src, 0, 0);
      cell.appendChild(canvas);

      const controls = document.createElement("div");
      controls.className = "reorder-controls";

      const prevBtn = document.createElement("button");
      prevBtn.type = "button"; prevBtn.className = "iconbtn"; prevBtn.draggable = false;
      prevBtn.title = "ย้ายไปก่อนหน้า"; prevBtn.textContent = "◀";
      prevBtn.disabled = idx === 0;
      prevBtn.onclick = (e)=>{
        e.stopPropagation();
        if(idx > 0){ [order[idx-1], order[idx]] = [order[idx], order[idx-1]]; renderGrid(); }
      };

      const num = document.createElement("div");
      num.className = "num";
      num.textContent = `หน้า ${origPage}`;
      num.title = `เดิมเป็นหน้า ${origPage} ในไฟล์ต้นฉบับ`;

      const nextBtn = document.createElement("button");
      nextBtn.type = "button"; nextBtn.className = "iconbtn"; nextBtn.draggable = false;
      nextBtn.title = "ย้ายไปถัดไป"; nextBtn.textContent = "▶";
      nextBtn.disabled = idx === order.length - 1;
      nextBtn.onclick = (e)=>{
        e.stopPropagation();
        if(idx < order.length - 1){ [order[idx+1], order[idx]] = [order[idx], order[idx+1]]; renderGrid(); }
      };

      controls.appendChild(prevBtn);
      controls.appendChild(num);
      controls.appendChild(nextBtn);
      cell.appendChild(controls);

      cell.addEventListener("dragstart", ()=>{
        dragSrcIdx = idx;
        cell.classList.add("dragging");
      });
      cell.addEventListener("dragover", (e)=>{
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        cell.classList.add("drag-over");
      });
      cell.addEventListener("dragleave", ()=> cell.classList.remove("drag-over"));
      cell.addEventListener("drop", (e)=>{
        e.preventDefault();
        cell.classList.remove("drag-over");
        if(dragSrcIdx === null || dragSrcIdx === idx) return;
        // The dragged item should land exactly where it was dropped (the
        // target's own pre-removal index), pushing the target — and
        // everything between the two — over by one slot. Using the
        // target's index `idx` directly (no "idx-1" compensation for a
        // forward drag) gives that "swap into the drop target's slot"
        // behavior in both directions: splice() clamps an index at or past
        // the shortened array's length to append at the end, so this also
        // works correctly when dropping onto the last cell.
        const [moved] = order.splice(dragSrcIdx, 1);
        order.splice(idx, 0, moved);
        dragSrcIdx = null;
        renderGrid();
      });
      cell.addEventListener("dragend", ()=>{
        dragSrcIdx = null;
        Array.from(grid.children).forEach(c=> c.classList.remove("dragging","drag-over"));
      });

      grid.appendChild(cell);
    });
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    setStatus(status, "กำลังโหลดหน้าเอกสาร...", "loading");
    body.style.display = "block";
    grid.innerHTML = "";
    result.classList.remove("show");
    outputBlob = null;
    runBtn.disabled = true;
    try{
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      numPages = pdfjsDoc.numPages;
      thumbCanvases = new Array(numPages+1);
      for(let i=1;i<=numPages;i++){
        const page = await pdfjsDoc.getPage(i);
        const viewport = page.getViewport({ scale: 70 / page.getViewport({scale:1}).width });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        thumbCanvases[i] = canvas;
      }
      order = Array.from({length:numPages}, (_,i)=> i+1);
      renderGrid();
      runBtn.disabled = numPages < 2;
      setStatus(status, `โหลดสำเร็จ · ทั้งหมด ${numPages} หน้า`, "ok");
    }catch(e){
      // Same reasoning as the ROTATE/SPLIT menus: this page needs pdf.js to
      // render the thumbnail grid before anything else can happen, so a
      // real-password file fails right here as a PasswordException.
      body.style.display = "none";
      if(e && e.name === "PasswordException"){
        setStatus(status, 'ไฟล์นี้ตั้งรหัสผ่านสำหรับเปิดไฟล์ไว้จริง (ไม่ใช่แค่ป้องกันการแก้ไข) เมนูนี้ปลดล็อกให้อัตโนมัติไม่ได้ กรุณาไปที่เมนู "ปลดล็อกรหัสผ่าน" เพื่อใส่รหัสผ่านที่ถูกต้องก่อน แล้วนำไฟล์ที่ปลดล็อกแล้วมาใช้งานเมนูนี้อีกครั้ง', "err");
      } else {
        setStatus(status, "ไม่สามารถอ่านไฟล์นี้ได้: " + e.message, "err");
      }
    }
  });

  resetBtn.onclick = ()=>{
    if(!numPages) return;
    order = Array.from({length:numPages}, (_,i)=> i+1);
    renderGrid();
  };

  runBtn.onclick = async ()=>{
    if(!buffer || order.length < 2) return;
    runBtn.disabled = true;
    setStatus(status, "กำลังบันทึกไฟล์...", "loading");
    try{
      let src = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      ({ doc: src } = await autoDecryptIfNeeded(src, buffer));
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, order.map(p=>p-1));
      copied.forEach(p=>out.addPage(p));
      const bytes = await out.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `จัดเรียงใหม่แล้ว <b>${order.length}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, `${fileName}_reordered`);
      result.classList.add("show");
      setStatus(status, "สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = false;
  };

  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; numPages = 0; thumbCanvases = []; order = [];
    grid.innerHTML = "";
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    runBtn.disabled = true;
    setStatus(status, "", "");
  };

  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, `${fileName}_reordered`, ".pdf")); };
})();

/* ================= OCR ================= */
(function(){
  const drop = document.getElementById("ocr-drop");
  const input = document.getElementById("ocr-input");
  const body = document.getElementById("ocr-body");
  const filelist = document.getElementById("ocr-filelist");
  const clearAllBtn = document.getElementById("ocr-clearall");
  const langThaiChk = document.getElementById("ocr-lang-tha");
  const langEngChk = document.getElementById("ocr-lang-eng");
  const forceChk = document.getElementById("ocr-force");
  const runBtn = document.getElementById("ocr-run");
  const cancelBtn = document.getElementById("ocr-cancel");
  const progress = document.getElementById("ocr-progress");
  const status = document.getElementById("ocr-status");
  const numwarnEl = document.getElementById("ocr-numwarn");
  const numwarnTextEl = document.getElementById("ocr-numwarn-text");
  const result = document.getElementById("ocr-result");
  const downloadBtn = document.getElementById("ocr-download");
  const downloadLabelEl = document.getElementById("ocr-download-label");
  const filenameInput = document.getElementById("ocr-filename-input");
  const filenameExtEl = document.getElementById("ocr-filename-ext");
  const filenameLabelEl = document.getElementById("ocr-filename-label");

  // Accounting staff mostly deal in piles of scanned invoices/receipts, not
  // one file at a time — `items` holds the whole batch. Each entry tracks
  // its own progress/result so one bad file doesn't block the rest.
  let items = [];
  let outputBlob = null, outputExt = ".pdf", outputBase = "document";
  let isRunning = false;
  let cancelRequested = false;

  const OCR_RENDER_WIDTH = 1800;
  const PAGE_TIMEOUT_MS = 60000;
  // Below this confidence (0-100), a token that looks like a number/amount
  // gets flagged for the accountant to double-check by eye — misreading a
  // single digit in an invoice total matters far more than a misread word.
  const NUM_CONF_THRESHOLD = 75;

  function withTimeout(promise, ms){
    return new Promise((resolve, reject)=>{
      const timer = setTimeout(()=> reject(new Error("timeout")), ms);
      promise.then(
        v=>{ clearTimeout(timer); resolve(v); },
        e=>{ clearTimeout(timer); reject(e); }
      );
    });
  }

  function langString(){
    const langs = [];
    if(langThaiChk.checked) langs.push("tha");
    if(langEngChk.checked) langs.push("eng");
    return langs.join("+") || "eng";
  }

  function createOcrWorker(){
    return Tesseract.createWorker(langString(), 1, {
      workerPath: "vendor/tesseract/worker.min.js",
      corePath: "vendor/tesseract/tesseract-core-lstm.wasm.js",
      langPath: "vendor/tessdata/",
      gzip: true,
      workerBlobURL: false,
      logger: ()=>{},
    });
  }

  // A token "looks like a number/amount" if, once thousands-separators are
  // stripped, it's essentially all digits (e.g. "1,234.56", "2567", "0.00").
  function looksNumeric(text){
    const cleaned = text.replace(/[,\s]/g, "");
    return /\d/.test(cleaned) && /^[+\-]?\d[\d.]*$/.test(cleaned);
  }

  function renderList(){
    filelist.innerHTML = "";
    items.forEach((it, idx)=>{
      const card = document.createElement("div");
      card.className = "filecard";
      const thumb = document.createElement("div");
      thumb.className = "thumb-ph";
      thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;color:var(--text-3);" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      card.appendChild(thumb);
      const meta = document.createElement("div");
      meta.className = "meta";
      const sub = it.statusText || (it.numPages ? `${it.numPages} หน้า` : "");
      meta.innerHTML = `<div class="name">${escapeHtml(it.file.name)}</div><div class="sub">${escapeHtml(sub)}</div>`;
      card.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "actions";
      const rmBtn = document.createElement("button");
      rmBtn.className = "iconbtn"; rmBtn.title = "ลบไฟล์นี้"; rmBtn.textContent = "✕";
      rmBtn.disabled = isRunning;
      rmBtn.onclick = ()=>{
        if(isRunning) return;
        items.splice(idx, 1);
        renderList();
        if(!items.length){ body.style.display = "none"; input.value = ""; }
      };
      actions.appendChild(rmBtn);
      card.appendChild(actions);
      filelist.appendChild(card);
    });
  }

  wireDrop(drop, input, async (files)=>{
    if(isRunning || !files.length) return;
    for(const file of files){
      const buf = await readFileAsArrayBuffer(file);
      let numPages = 0;
      try{
        const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
        numPages = doc.numPages;
      }catch(e){ numPages = 0; }
      items.push({
        file, buffer: buf, fileName: file.name.replace(/\.pdf$/i, ""), numPages,
        status: "pending", statusText: "", outputBlob: null, lowConfFlags: [],
      });
    }
    body.style.display = "block";
    result.classList.remove("show");
    numwarnEl.style.display = "none";
    setStatus(status, "", "");
    renderList();
  }, [".pdf"]);

  clearAllBtn.onclick = ()=>{
    if(isRunning) return;
    items = [];
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    numwarnEl.style.display = "none";
    setStatus(status, "", "");
    renderList();
  };

  runBtn.onclick = async ()=>{
    if(!items.length || isRunning) return;
    if(!langThaiChk.checked && !langEngChk.checked){ setStatus(status, "กรุณาเลือกภาษาอย่างน้อย 1 ภาษา", "err"); return; }
    if(typeof Tesseract === "undefined"){ setStatus(status, "ไม่พบโมดูล OCR กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง", "err"); return; }

    isRunning = true;
    runBtn.disabled = true;
    clearAllBtn.disabled = true;
    cancelBtn.style.display = "inline-flex";
    cancelRequested = false;
    progress.style.display = "block"; progress.value = 0;
    numwarnEl.style.display = "none";
    result.classList.remove("show");

    items.forEach(it=>{ it.status = "pending"; it.statusText = "รอคิว..."; it.outputBlob = null; it.lowConfFlags = []; });
    renderList();

    let worker = null;
    let cancelledOverall = false;
    const totalPagesAll = items.reduce((s, it)=> s + (it.numPages || 1), 0) || 1;
    let pagesDoneSoFar = 0;

    try{
      setStatus(status, "กำลังเตรียมโมดูล OCR...", "loading");
      worker = await createOcrWorker();

      for(let idx = 0; idx < items.length; idx++){
        if(cancelRequested){ cancelledOverall = true; break; }
        const it = items[idx];
        it.status = "running"; it.statusText = "กำลังเตรียมไฟล์...";
        renderList();

        try{
          let doc = await PDFDocument.load(it.buffer.slice(0), { ignoreEncryption: true });
          ({ doc } = await autoDecryptIfNeeded(doc, it.buffer));
          doc.registerFontkit(fontkit);
          // Lazy font embed: only embed the invisible-text font the moment
          // the first glyph is actually about to be drawn — embedding it
          // eagerly and then never drawing anything (e.g. every page
          // skipped/cancelled) makes fontkit's subsetter crash uncatchably.
          let ocrFont = null;
          async function ensureOcrFont(){
            if(!ocrFont) ocrFont = await doc.embedFont(ocrFontBytes(), { subset: true });
            return ocrFont;
          }
          const pdfPages = doc.getPages();
          const total = pdfPages.length;
          const pdfjsDoc = await pdfjsLib.getDocument({ data: it.buffer.slice(0) }).promise;

          let ocredCount = 0, skippedCount = 0, timedOutCount = 0, cancelledThisFile = false, confSum = 0, confCount = 0;

          for(let i = 1; i <= total; i++){
            if(cancelRequested){ cancelledThisFile = true; cancelledOverall = true; break; }
            it.statusText = `กำลังประมวลผลหน้า ${i}/${total}...`;
            setStatus(status, `ไฟล์ ${idx+1}/${items.length} "${it.file.name}" — หน้า ${i}/${total}...`, "loading");
            renderList();
            const pjsPage = await pdfjsDoc.getPage(i);

            if(!forceChk.checked){
              const tc = await pjsPage.getTextContent();
              const hasText = tc.items.some(w => w.str && w.str.trim().length > 0);
              if(hasText){
                skippedCount++;
                pagesDoneSoFar++;
                progress.value = Math.round((pagesDoneSoFar/totalPagesAll)*100);
                continue;
              }
            }

            const baseViewport = pjsPage.getViewport({ scale: 1 });
            const scale = OCR_RENDER_WIDTH / baseViewport.width;
            const viewport = pjsPage.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width; canvas.height = viewport.height;
            await pjsPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

            let data;
            try{
              it.statusText = `กำลังอ่านข้อความหน้า ${i}/${total} ด้วย OCR...`;
              renderList();
              const recognized = await withTimeout(worker.recognize(canvas, {}, { blocks: true, text: true }), PAGE_TIMEOUT_MS);
              data = recognized.data;
            }catch(e){
              timedOutCount++;
              try{ worker.terminate(); }catch(_e){}
              try{ worker = await createOcrWorker(); }catch(_e){ worker = null; }
              pagesDoneSoFar++;
              progress.value = Math.round((pagesDoneSoFar/totalPagesAll)*100);
              continue;
            }
            if(typeof data.confidence === "number"){ confSum += data.confidence; confCount++; }

            const pdfPage = pdfPages[i-1];
            const { width: pdfW, height: pdfH } = pdfPage.getSize();
            const ptPerPx = pdfW / canvas.width;

            // Draws one word as its own tiny invisible text run, positioned at
            // its own bbox — this is the fallback used when a whole line
            // can't be drawn as a single string (see below), and used on its
            // own for the low-confidence numeric-word scan.
            async function drawInvisibleWord(word){
              const wText = (word.text || "").trim();
              if(!wText || !word.bbox) return;
              const b = word.bbox;
              const wPt = (b.x1 - b.x0) * ptPerPx, hPt = (b.y1 - b.y0) * ptPerPx;
              if(wPt <= 0 || hPt <= 0) return;
              let size = Math.max(1, hPt * 0.85);
              try{
                const font = await ensureOcrFont();
                const measured = font.widthOfTextAtSize(wText, size);
                if(measured > 0) size = Math.max(1, size * Math.max(0.5, Math.min(1.8, wPt / measured)));
                pdfPage.drawText(wText, { x: b.x0 * ptPerPx, y: pdfH - (b.y1 * ptPerPx), size, font, opacity: 0 });
              }catch(e){ /* skip glyph the font can't encode */ }
            }

            for(const block of (data.blocks || [])){
              for(const para of (block.paragraphs || [])){
                for(const line of (para.lines || [])){
                  // Low-confidence numeric flagging still needs per-word
                  // text/confidence, so this scan stays at word granularity
                  // even though the drawn text below is per LINE.
                  for(const word of (line.words || [])){
                    const wText = (word.text || "").trim();
                    if(wText && typeof word.confidence === "number" && word.confidence < NUM_CONF_THRESHOLD && looksNumeric(wText)){
                      it.lowConfFlags.push({ page: i, text: wText, confidence: Math.round(word.confidence) });
                    }
                  }

                  // Draw the whole LINE as one invisible text object instead
                  // of one per word. Tesseract often reports a Thai vowel or
                  // tone mark (sitting above/below its base consonant, not
                  // beside it) as its own separate "word" with a disjoint
                  // bounding box. Drawing each of those as an independently
                  // positioned PDF text run made copy/search reconstruct
                  // them out of order — the text looked fine on screen (it's
                  // invisible) but came out with garbled/reordered Thai
                  // vowels when copied or searched. line.text is already
                  // assembled by Tesseract in the correct logical order, so
                  // drawing it once at the line's own bbox keeps every mark
                  // attached to its consonant.
                  const text = (line.text || "").trim();
                  if(!text || !line.bbox) continue;
                  const bbox = line.bbox;
                  const wPt = (bbox.x1 - bbox.x0) * ptPerPx;
                  const hPt = (bbox.y1 - bbox.y0) * ptPerPx;
                  if(wPt <= 0 || hPt <= 0) continue;
                  const xPt = bbox.x0 * ptPerPx;
                  const yPt = pdfH - (bbox.y1 * ptPerPx);
                  let size = hPt * 0.85;
                  if(size < 1) size = 1;
                  try{
                    const font = await ensureOcrFont();
                    const measured = font.widthOfTextAtSize(text, size);
                    if(measured > 0){
                      const ratio = wPt / measured;
                      size = size * Math.max(0.5, Math.min(1.8, ratio));
                    }
                    if(size < 1) size = 1;
                    pdfPage.drawText(text, { x: xPt, y: yPt, size, font, opacity: 0 });
                  }catch(e){
                    // Rare: some character on this line can't be encoded by
                    // the embedded font (an odd symbol Tesseract hallucinated),
                    // which fails the whole line's drawText call. Degrade to
                    // per-word instead of losing the whole line's searchable
                    // text — this is the one case where fragmenting is an
                    // acceptable trade-off since drawing nothing is worse.
                    for(const word of (line.words || [])) await drawInvisibleWord(word);
                  }
                }
              }
            }

            ocredCount++;
            pagesDoneSoFar++;
            progress.value = Math.round((pagesDoneSoFar/totalPagesAll)*100);
            await new Promise(r=>setTimeout(r,0));
          }

          const bytes = await doc.save();
          it.outputBlob = new Blob([bytes], { type:"application/pdf" });
          it.ocredCount = ocredCount; it.total = total;
          const avgConf = confCount ? Math.round(confSum/confCount) : null;
          const confPart = avgConf !== null ? ` · มั่นใจเฉลี่ย ~${avgConf}%` : "";
          const skipPart = skippedCount ? ` (ข้าม ${skippedCount} หน้าที่มีข้อความอยู่แล้ว)` : "";
          const timeoutPart = timedOutCount ? ` (ข้าม ${timedOutCount} หน้าที่ใช้เวลานานเกินไป)` : "";
          it.statsText = `OCR แล้ว <b>${ocredCount}</b> จาก <b>${total}</b> หน้า${skipPart}${timeoutPart}${confPart} · <b>${fmtBytes(it.outputBlob.size)}</b>`;
          it.status = cancelledThisFile ? "cancelled" : "done";
          it.statusText = (cancelledThisFile ? "✋ หยุดกลางคัน — " : "✓ เสร็จแล้ว — ") + `OCR ${ocredCount}/${total} หน้า${avgConf !== null ? ` (มั่นใจ ~${avgConf}%)` : ""}`;
        }catch(e){
          it.status = "error";
          it.statusText = "✕ เกิดข้อผิดพลาด: " + e.message;
        }
        renderList();
      }

      items.forEach(it=>{
        if(it.status === "pending"){ it.status = "cancelled"; it.statusText = "ข้ามไป (ยกเลิกก่อนเริ่มไฟล์นี้)"; }
      });
      renderList();

      const doneItems = items.filter(it=> it.outputBlob);
      const allFlags = [];
      items.forEach(it=> (it.lowConfFlags||[]).forEach(f=> allFlags.push({ ...f, file: it.file.name })));

      if(allFlags.length){
        const grouped = {};
        allFlags.forEach(f=>{ (grouped[f.file] ||= new Set()).add(f.page); });
        const lines = Object.entries(grouped).map(([file, pages])=>
          `${file}: หน้า ${Array.from(pages).sort((a,b)=>a-b).join(", ")}`
        );
        numwarnTextEl.innerHTML = `<b>ควรตรวจสอบซ้ำ:</b> พบตัวเลข/จำนวนเงินที่ OCR อ่านได้ไม่มั่นใจนัก (ความมั่นใจต่ำกว่า ${NUM_CONF_THRESHOLD}%) รวม ${allFlags.length} จุด — แนะนำเปิดไฟล์เทียบกับต้นฉบับก่อนนำไปใช้งานจริง:<br>` +
          lines.map(l=> "• " + escapeHtml(l)).join("<br>");
        numwarnEl.style.display = "flex";
      }else{
        numwarnEl.style.display = "none";
      }

      if(!doneItems.length){
        setStatus(status, cancelledOverall ? "หยุดก่อนได้ผลลัพธ์ใดๆ" : "เกิดข้อผิดพลาด ไม่มีไฟล์ที่ทำสำเร็จ", cancelledOverall ? "warn" : "err");
      }else if(items.length === 1){
        const it = doneItems[0];
        outputBlob = it.outputBlob; outputExt = ".pdf"; outputBase = `${it.fileName}_ocr`;
        filenameExtEl.textContent = outputExt;
        downloadLabelEl.textContent = "ดาวน์โหลดไฟล์";
        filenameLabelEl.textContent = "ชื่อไฟล์ก่อนดาวน์โหลด";
        setFilenameDefault(filenameInput, outputBase);
        result.querySelector(".stats").innerHTML = it.statsText;
        result.classList.add("show");
        setStatus(status, cancelledOverall ? "หยุดแล้ว (ดาวน์โหลดผลลัพธ์เท่าที่ทำไปแล้วได้)" : "OCR สำเร็จ", cancelledOverall ? "warn" : "ok");
      }else{
        const zip = new JSZip();
        doneItems.forEach(it=> zip.file(`${it.fileName}_ocr.pdf`, it.outputBlob));
        outputBlob = await zip.generateAsync({ type:"blob" });
        outputExt = ".zip"; outputBase = "ocr_results";
        filenameExtEl.textContent = outputExt;
        downloadLabelEl.textContent = "ดาวน์โหลดทั้งหมด (ZIP)";
        filenameLabelEl.textContent = "ชื่อไฟล์ ZIP ก่อนดาวน์โหลด";
        setFilenameDefault(filenameInput, outputBase);
        const totalOcred = doneItems.reduce((s,it)=> s + it.ocredCount, 0);
        const totalPagesDone = doneItems.reduce((s,it)=> s + it.total, 0);
        result.querySelector(".stats").innerHTML = `สำเร็จ <b>${doneItems.length}</b> จาก <b>${items.length}</b> ไฟล์ · รวม <b>${totalOcred}</b>/<b>${totalPagesDone}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
        result.classList.add("show");
        setStatus(status, cancelledOverall ? "หยุดแล้ว (ดาวน์โหลดผลลัพธ์เท่าที่ทำไปแล้วได้)" : "OCR สำเร็จ", cancelledOverall ? "warn" : "ok");
      }
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    if(worker){ try{ await worker.terminate(); }catch(e){} }
    progress.style.display = "none";
    cancelBtn.style.display = "none";
    cancelRequested = false;
    isRunning = false;
    runBtn.disabled = false;
    clearAllBtn.disabled = false;
    renderList();
  };

  cancelBtn.onclick = ()=>{
    cancelRequested = true;
    setStatus(status, "กำลังหยุด... (จะหยุดหลังหน้าปัจจุบันทำเสร็จ หรือหมดเวลาของหน้านั้น)", "loading");
  };

  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, outputBase, outputExt)); };
})();

/* ================= JPG TO PDF ================= */
(function(){
  const drop = document.getElementById("jpgpdf-drop");
  const input = document.getElementById("jpgpdf-input");
  const list = document.getElementById("jpgpdf-list");
  const pagesizeSel = document.getElementById("jpgpdf-pagesize");
  const runBtn = document.getElementById("jpgpdf-run");
  const clearBtn = document.getElementById("jpgpdf-clear");
  const status = document.getElementById("jpgpdf-status");
  const result = document.getElementById("jpgpdf-result");
  const downloadBtn = document.getElementById("jpgpdf-download");
  const filenameInput = document.getElementById("jpgpdf-filename-input");
  let items = [];
  let outputBlob = null;

  function isPng(file){ return /png$/i.test(file.type) || /\.png$/i.test(file.name); }

  async function makeThumb(file){
    return new Promise((resolve)=>{
      const url = URL.createObjectURL(file);
      const imgEl = new Image();
      imgEl.onload = ()=>{
        const targetW = 88;
        const scale = targetW / imgEl.naturalWidth;
        const canvas = document.createElement("canvas");
        canvas.width = targetW; canvas.height = Math.round(imgEl.naturalHeight*scale) || targetW;
        canvas.getContext("2d").drawImage(imgEl, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve({ canvas, width: imgEl.naturalWidth, height: imgEl.naturalHeight });
      };
      imgEl.onerror = ()=>{ URL.revokeObjectURL(url); resolve({ canvas:null, width:0, height:0 }); };
      imgEl.src = url;
    });
  }

  function render(){
    list.innerHTML = "";
    items.forEach((it, idx)=>{
      const card = document.createElement("div");
      card.className = "filecard";
      const thumb = document.createElement("canvas");
      card.appendChild(thumb);
      if(it.thumbCanvas){
        thumb.width = it.thumbCanvas.width; thumb.height = it.thumbCanvas.height;
        thumb.getContext("2d").drawImage(it.thumbCanvas, 0, 0);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${escapeHtml(it.file.name)}</div><div class="sub">${it.width}×${it.height}px · ${fmtBytes(it.file.size)}</div>`;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.innerHTML = `
        <button class="iconbtn" data-act="up" title="ขึ้น">↑</button>
        <button class="iconbtn" data-act="down" title="ลง">↓</button>
        <button class="iconbtn" data-act="rm" title="ลบ">✕</button>`;
      actions.querySelector('[data-act="up"]').onclick = ()=>{ if(idx>0){ [items[idx-1],items[idx]]=[items[idx],items[idx-1]]; render(); } };
      actions.querySelector('[data-act="down"]').onclick = ()=>{ if(idx<items.length-1){ [items[idx+1],items[idx]]=[items[idx],items[idx+1]]; render(); } };
      actions.querySelector('[data-act="rm"]').onclick = ()=>{ items.splice(idx,1); render(); };
      card.appendChild(meta); card.appendChild(actions);
      list.appendChild(card);
    });
    runBtn.disabled = items.length === 0;
    result.classList.remove("show"); outputBlob = null;
  }

  async function addFiles(files){
    for(const file of files){
      if(!/^image\/(jpeg|png)$/.test(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) continue;
      const buf = await readFileAsArrayBuffer(file);
      const { canvas, width, height } = await makeThumb(file);
      items.push({ file, buffer: buf, png: isPng(file), width, height, thumbCanvas: canvas });
    }
    render();
  }
  wireDrop(drop, input, addFiles, [".jpg",".jpeg",".png"]);
  clearBtn.onclick = ()=>{ items = []; render(); setStatus(status,"",""); };

  runBtn.onclick = async ()=>{
    if(!items.length) return;
    setStatus(status, "กำลังสร้างไฟล์ PDF...", "loading");
    runBtn.disabled = true;
    try{
      const out = await PDFDocument.create();
      const useA4 = pagesizeSel.value === "a4";
      for(const it of items){
        const bytes = new Uint8Array(it.buffer);
        const img = it.png ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        if(useA4){
          const [pw, ph] = PageSizes.A4;
          const page = out.addPage([pw, ph]);
          const margin = 28;
          const maxW = pw - margin*2, maxH = ph - margin*2;
          const scale = Math.min(maxW/img.width, maxH/img.height, 1) || 1;
          const w = img.width*scale, h = img.height*scale;
          page.drawImage(img, { x:(pw-w)/2, y:(ph-h)/2, width:w, height:h });
        } else {
          const page = out.addPage([img.width, img.height]);
          page.drawImage(img, { x:0, y:0, width:img.width, height:img.height });
        }
      }
      const bytes = await out.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `<b>${items.length}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      const firstName = items.length ? items[0].file.name.replace(/\.(jpe?g|png)$/i,"") : "images";
      setFilenameDefault(filenameInput, `${firstName}`);
      result.classList.add("show");
      setStatus(status, "สร้างไฟล์ PDF สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = items.length === 0;
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, "images", ".pdf")); };
})();

/* ================= PDF TO WORD =================
   Client-side-only text extraction + reflow: reads each page's text items
   via pdf.js getTextContent(), clusters them into lines/paragraphs by
   Y-position (falling back on pdf.js's hasEOL hint when present), then
   builds a .docx with the "docx" npm package (bundled as vendor/docx.umd.min.js,
   exposing a global `docx`). This is fundamentally lossy — tables, multi-
   column layout, floating images and exact positioning are not
   reconstructed, only reading-order text — which is explained to the user
   in the panel's note. Scanned (image-only) PDFs have no text layer to
   extract; the note points such users at the OCR menu first (OCR embeds an
   invisible text layer that this feature can then pick up). */
(function(){
  const drop = document.getElementById("pdfword-drop");
  const input = document.getElementById("pdfword-input");
  const body = document.getElementById("pdfword-body");
  const filenameEl = document.getElementById("pdfword-filename");
  const removeBtn = document.getElementById("pdfword-remove");
  const runBtn = document.getElementById("pdfword-run");
  const progress = document.getElementById("pdfword-progress");
  const status = document.getElementById("pdfword-status");
  const result = document.getElementById("pdfword-result");
  const downloadBtn = document.getElementById("pdfword-download");
  const filenameInput = document.getElementById("pdfword-filename-input");

  let buffer = null, fileName = "document", outputBlob = null;

  function reset(){
    buffer = null; outputBlob = null;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    if(!file) return;
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = file.name;
    buffer = await readFileAsArrayBuffer(file);
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, "", "");
  }, [".pdf"]);

  removeBtn.onclick = reset;

  // Groups a page's pdf.js text items into visual "rows" (lines), ordered
  // top-to-bottom, each row's items ordered left-to-right. Uses Y-proximity
  // clustering (tolerant to sub-pixel baseline jitter within one line) and
  // ends a row early when pdf.js flags hasEOL on an item.
  function groupItemsIntoRows(items){
    const rows = [];
    let current = null;
    for(const it of items){
      if(!it || typeof it.str !== "string") continue;
      const tr = it.transform || [1,0,0,1,0,0];
      const x = tr[4], y = tr[5];
      const fontSize = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || Math.abs(tr[0]) || 10;
      if(it.str.length){
        if(current && Math.abs(y - current.y) <= Math.max(1.5, fontSize*0.35)){
          current.items.push({ x, str: it.str, width: it.width || 0, fontSize });
          current.maxFontSize = Math.max(current.maxFontSize, fontSize);
        } else {
          current = { y, items: [{ x, str: it.str, width: it.width || 0, fontSize }], maxFontSize: fontSize };
          rows.push(current);
        }
      }
      if(it.hasEOL) current = null;
    }
    rows.forEach(r => r.items.sort((a,b)=>a.x-b.x));
    rows.sort((a,b)=> b.y - a.y); // PDF y grows upward -> topmost first
    return rows;
  }

  // Joins one row's items into a single string, inserting a space where a
  // sizeable horizontal gap suggests a word boundary that the PDF's content
  // stream didn't encode as an explicit space glyph.
  function joinRowText(rowItems){
    let text = "";
    let prevEndX = null;
    for(const it of rowItems){
      if(prevEndX !== null){
        const gap = it.x - prevEndX;
        const threshold = it.fontSize * 0.28;
        if(gap > threshold && !/^\s/.test(it.str) && !/\s$/.test(text)) text += " ";
      }
      text += it.str;
      prevEndX = it.x + (it.width || it.str.length * it.fontSize * 0.5);
    }
    return text.replace(/\s+$/, "");
  }

  // Detects a single stable vertical "gutter" (empty band) running through
  // most of the page — the classic signature of a 2-column layout (e.g. a
  // resume with a narrow sidebar). When found, items are split into a left
  // and right group and rows are produced separately for each, left column
  // fully top-to-bottom then right column fully top-to-bottom — much closer
  // to true reading order than treating both columns as one interleaved
  // stream of same-height lines. Falls back to plain single-column grouping
  // whenever no such gutter is found (the vast majority of PDFs), so this
  // only changes behavior for genuinely multi-column pages.
  // Returns { rows, splitIndex }: `rows` is the page's rows in final reading
  // order; `splitIndex` is -1 for a plain single-stream page, or the index
  // within `rows` where the right column's rows begin (so callers — table
  // detection in particular — can treat that as a hard block boundary
  // instead of relying on a Y-gap that may not exist at the seam between
  // two independent column streams).
  function splitIntoColumnsAndGroupRows(items, pageWidth){
    const plain = ()=> ({ rows: groupItemsIntoRows(items), splitIndex: -1 });
    if(!pageWidth || pageWidth <= 0 || items.length < 6) return plain();

    const BUCKETS = 120;
    const bucketW = pageWidth / BUCKETS;
    const covered = new Array(BUCKETS).fill(false);
    let anyValid = false;
    for(const it of items){
      if(!it || typeof it.str !== "string" || !it.str.trim()) continue;
      const tr = it.transform || [1,0,0,1,0,0];
      const x0 = tr[4], x1 = x0 + (it.width || 0);
      if(x1 <= x0) continue;
      anyValid = true;
      const b0 = Math.max(0, Math.floor(x0 / bucketW));
      const b1 = Math.min(BUCKETS - 1, Math.ceil(x1 / bucketW));
      for(let b = b0; b <= b1; b++) covered[b] = true;
    }
    if(!anyValid) return plain();

    // Find every contiguous uncovered run in the middle portion of the page
    // (never split on the outer margins), not just the widest one. A page
    // laid out as a genuine 2-zone document (e.g. a resume with one sidebar)
    // has exactly one such gap of real substance. A multi-column TABLE has
    // several roughly-comparable gaps (one between each pair of columns) —
    // picking just the widest of those and splitting the whole page into
    // "everything left of it" / "everything right of it" tears every table
    // row in half and interleaves the pieces in the wrong order, which is
    // worse than not splitting at all. So: collect all runs, and only go
    // ahead when there's a single dominant gap with no comparably-wide
    // runner-up — that runner-up check is what keeps tables out.
    const loBound = Math.floor(BUCKETS * 0.15), hiBound = Math.ceil(BUCKETS * 0.85);
    const runs = [];
    let runStart = -1;
    for(let b = loBound; b <= hiBound; b++){
      if(!covered[b]){
        if(runStart === -1) runStart = b;
      } else {
        if(runStart !== -1){ runs.push({ start: runStart, len: b - runStart }); runStart = -1; }
      }
    }
    if(runStart !== -1) runs.push({ start: runStart, len: hiBound + 1 - runStart });

    // Discard any run with no ink after it anywhere on the page — that's
    // just trailing margin/whitespace past the last content, not a gutter
    // BETWEEN two populated zones, and can otherwise end up wider than the
    // real gutter (e.g. a right column that doesn't reach the 85% bound).
    const realRuns = runs.filter(r => covered.slice(r.start + r.len).some(Boolean));

    realRuns.sort((a,b)=> b.len - a.len);
    const best = realRuns[0];
    const minGutterBuckets = Math.max(8, pageWidth * 0.015) / bucketW;
    if(!best || best.len < minGutterBuckets) return plain();
    // a second gap at least half as wide as the best one is treated as
    // "multiple comparable gutters" -> likely a table grid, not a 2-zone page
    if(realRuns[1] && realRuns[1].len >= best.len * 0.5) return plain();

    const bestStart = best.start, bestLen = best.len;

    const gutterStart = bestStart * bucketW;
    const gutterEnd = (bestStart + bestLen) * bucketW;

    const leftItems = [], rightItems = [];
    for(const it of items){
      if(!it || typeof it.str !== "string"){ leftItems.push(it); continue; }
      const tr = it.transform || [1,0,0,1,0,0];
      const x0 = tr[4], x1 = x0 + (it.width || 0);
      if(!it.str.trim()){ leftItems.push(it); continue; } // EOL/spacer markers: side doesn't matter
      if(x1 <= gutterStart + 0.5){ leftItems.push(it); }
      else if(x0 >= gutterEnd - 0.5){ rightItems.push(it); }
      else {
        // straddles the gutter (rare) — assign to whichever side holds most of its width
        const leftPart = Math.max(0, Math.min(x1, gutterStart) - x0);
        const rightPart = Math.max(0, x1 - Math.max(x0, gutterEnd));
        (rightPart > leftPart ? rightItems : leftItems).push(it);
      }
    }
    const leftRows = groupItemsIntoRows(leftItems);
    const rightRows = groupItemsIntoRows(rightItems);
    // Require a real two-sided split (guards against a stray page-number or
    // watermark in a corner being mistaken for a whole column).
    if(leftRows.length < 2 || rightRows.length < 2) return plain();

    // A single gutter with rows on both sides is still ambiguous: it's the
    // exact same signature for a resume-style sidebar (two independent
    // streams of content) AND for a genuine 2-column TABLE (e.g. a
    // term/definition glossary), where each left row has a matching right
    // row on (almost) the same baseline. Those two need opposite handling —
    // a sidebar should be read left-column-then-right-column, but a table
    // should stay row-by-row (which plain() already does correctly, since
    // same-Y items merge into one row regardless of the gutter). Tell them
    // apart by how often rows line up across the gutter: mostly-independent
    // Y positions (sidebar) vs. mostly-paired Y positions (table).
    function rowYMatchFraction(a, b){
      if(!a.length) return 0;
      let matched = 0;
      for(const r of a){
        const tol = Math.max(3, (r.maxFontSize || 10) * 0.5);
        if(b.some(o => Math.abs(o.y - r.y) <= tol)) matched++;
      }
      return matched / a.length;
    }
    const rowAlignFrac = Math.min(rowYMatchFraction(leftRows, rightRows), rowYMatchFraction(rightRows, leftRows));
    if(rowAlignFrac >= 0.6) return plain();

    return { rows: leftRows.concat(rightRows), splitIndex: leftRows.length };
  }

  // Splits a page's rows into "blocks" at big vertical gaps (same signal
  // used to decide where to insert a blank paragraph) and at the seam
  // between two column streams (see splitIndex above, which has no
  // guaranteed Y-gap since the right column restarts near the top of the
  // page). Each block is later tried as a table; if it isn't one, its rows
  // become ordinary paragraphs exactly as before.
  function groupRowsIntoBlocks(rows, splitIndex){
    const blocks = [];
    let current = [];
    let prevY = null;
    rows.forEach((row, i)=>{
      const fontSize = row.maxFontSize || 11;
      let isBreak = (i === splitIndex && i > 0);
      if(!isBreak && prevY !== null){
        const gap = prevY - row.y;
        const lineHeightEstimate = Math.max(fontSize, 6) * 1.3;
        if(gap > lineHeightEstimate * 1.6) isBreak = true;
      }
      if(isBreak && current.length){ blocks.push(current); current = []; }
      current.push(row);
      prevY = row.y;
    });
    if(current.length) blocks.push(current);
    return blocks;
  }

  // Finds vertical "column gutters" — x-bands with no ink from ANY row in
  // the block — strictly between the block's leftmost and rightmost ink, so
  // a gap only counts if there's real content on both sides of it. Because
  // it's the union across every row, natural gaps between two OCR'd words
  // inside one cell essentially never survive (some other row's cell would
  // have to break at that exact x too), while a real column boundary — the
  // same empty band underneath every row — always does.
  function detectColumnGutters(rows, xMin, xMax, avgFontSize){
    if(!(xMax > xMin)) return [];
    const buckets = Math.max(20, Math.min(300, Math.round((xMax - xMin) / 3)));
    const bucketW = (xMax - xMin) / buckets;
    // Count how many DISTINCT ROWS put ink in each bucket (not just whether
    // any row did) — a block can legitimately include a stray non-tabular
    // line or two alongside dozens of real table rows (e.g. a label line
    // above a data table that got merged into the same block because
    // nothing separated them by a big enough vertical gap); tolerating a
    // small fraction of rows touching a would-be gutter keeps that gutter
    // usable instead of one outlier row silently defeating the whole
    // table detection.
    const rowCoverCount = new Array(buckets).fill(0);
    rows.forEach(row => {
      const rowCovered = new Array(buckets).fill(false);
      row.items.forEach(it=>{
        if(!it.str || !it.str.trim()) return;
        const x0 = it.x, x1 = it.x + (it.width || 0);
        const b0 = Math.max(0, Math.floor((x0 - xMin) / bucketW));
        const b1 = Math.min(buckets - 1, Math.ceil((x1 - xMin) / bucketW));
        for(let b = b0; b <= b1; b++) rowCovered[b] = true;
      });
      for(let b = 0; b < buckets; b++) if(rowCovered[b]) rowCoverCount[b]++;
    });
    const strayAllowance = Math.max(1, Math.floor(rows.length * 0.1));
    const covered = rowCoverCount.map(c => c > strayAllowance);
    const minGutterPt = Math.max(10, (avgFontSize || 10) * 1.2);
    const minGutterBuckets = minGutterPt / bucketW;
    const gutters = [];
    let runStart = -1;
    for(let b = 0; b < buckets; b++){
      if(!covered[b]){ if(runStart === -1) runStart = b; }
      else {
        if(runStart !== -1){
          if(runStart > 0 && b - runStart >= minGutterBuckets){
            gutters.push([xMin + runStart * bucketW, xMin + b * bucketW]);
          }
          runStart = -1;
        }
      }
    }
    // a run touching the end (buckets-1 uncovered) is trailing content, not
    // a between-columns gutter — deliberately not counted, same as above
    return gutters;
  }

  // Single-pass table detection over an exact row range: finds gutters,
  // assigns every row's items to a column, and requires most rows to
  // actually populate >=2 columns. Returns null for anything that doesn't
  // clearly look like a grid. Also returns, per row, whether it fit the
  // grid (populated >=2 columns) — used by the caller to trim non-tabular
  // rows off either end of a block (see tryBuildTableBlock below).
  function tryBuildTableBlockCore(rows){
    if(rows.length < 4) return null;
    const multiItemRows = rows.filter(r => r.items.filter(it => it.str && it.str.trim()).length >= 2);
    if(multiItemRows.length < Math.max(3, rows.length * 0.6)) return null;

    let xMin = Infinity, xMax = -Infinity, fsSum = 0, fsCount = 0;
    rows.forEach(r => r.items.forEach(it=>{
      if(!it.str || !it.str.trim()) return;
      xMin = Math.min(xMin, it.x);
      xMax = Math.max(xMax, it.x + (it.width || 0));
      fsSum += it.fontSize; fsCount++;
    }));
    if(!isFinite(xMin) || !isFinite(xMax) || xMax <= xMin) return null;
    const avgFontSize = fsCount ? fsSum / fsCount : 11;

    const gutters = detectColumnGutters(rows, xMin, xMax, avgFontSize);
    const numCols = gutters.length + 1;
    if(numCols < 2 || numCols > 12) return null;

    const bounds = [xMin];
    gutters.forEach(g => bounds.push(g[0], g[1]));
    bounds.push(xMax);
    function colIndexForX(x){
      for(let c = 0; c < numCols - 1; c++){
        if(x < bounds[c*2 + 1]) return c;
      }
      return numCols - 1;
    }

    const cellsGrid = rows.map(()=> Array.from({ length: numCols }, ()=>[]));
    rows.forEach((row, ri)=>{
      row.items.forEach(it=>{
        if(!it.str || !it.str.trim()) return;
        cellsGrid[ri][colIndexForX(it.x)].push(it);
      });
    });

    const rowFits = cellsGrid.map(cells => cells.filter(c => c.length > 0).length >= 2);
    // Most rows must actually populate at least 2 of the columns — guards
    // against a block that happens to share one empty band without the
    // content really forming a grid.
    const rowsWithMultiCols = rowFits.filter(Boolean).length;
    if(rowsWithMultiCols < Math.max(3, rows.length * 0.5)) return null;

    const cellTexts = cellsGrid.map(cells => cells.map(c => joinRowText(c.slice().sort((a,b)=>a.x-b.x))));
    return { numCols, cellTexts, avgFontSize, rowFits };
  }

  // Tries to read a block of rows as a data table. A block found by
  // groupRowsIntoBlocks can legitimately contain non-tabular lines glued
  // onto the front or back of a real table (e.g. "ชื่อพนักงาน ...",
  // "ตำแหน่ง ..." label lines sitting just above a timesheet grid, or a
  // differently-laid-out summary section below it, with no vertical gap
  // big enough to split them into their own blocks). Running gutter
  // detection over the whole block at once lets those lines pollute it —
  // a long label+value line spans a wide x-range and can bridge right
  // over a real column gutter — so instead this first narrows to a
  // plausible candidate range using two cheap, gutter-independent signals,
  // then only runs the real (gutter-based) detector on that narrowed
  // range, re-narrowing by its own fit results until stable:
  //   1. Text length: a genuine table cell holds a short token (a date, a
  //      time, a number, a short word) — a row containing a long run of
  //      text in a single item is a label/sentence line, not a data row.
  //   2. Row spacing: real data rows repeat the same line-to-line spacing
  //      throughout the table. Rather than assuming the table starts right
  //      at the front of the short-text candidate range (a label line just
  //      above the table, like a "worktime" line, is often itself short
  //      *and* sits an oddly-spaced gap away from both its neighbors), find
  //      the longest run of consecutive rows sharing one consistent gap —
  //      that run is the table; anything before or after it (mis-spaced
  //      label lines, a differently-laid-out summary section) is dropped.
  // Returns { table, preRows, postRows } — preRows/postRows are the
  // trimmed-off rows, to be rendered as ordinary paragraphs by the caller
  // — or null if no table-like range is found (normal prose, resume
  // bullet lists, etc. all end up here and keep flowing as plain
  // paragraphs exactly as before).
  function tryBuildTableBlock(rows){
    const looksTabular = rows.map(row=>{
      const items = row.items.filter(it => it.str && it.str.trim());
      if(items.length < 2) return false;
      const maxLen = Math.max(...items.map(it => it.str.trim().length));
      return maxLen <= 20;
    });
    const candStart = looksTabular.indexOf(true);
    const candEnd = looksTabular.lastIndexOf(true);
    if(candStart === -1) return null;

    let start = candStart, end = candEnd;
    const gaps = [];
    for(let i = candStart + 1; i <= candEnd; i++) gaps.push(rows[i-1].y - rows[i].y);
    if(gaps.length){
      // Bucket gaps to the nearest point and find the most common value —
      // that's the table's repeating row spacing — then take the longest
      // run of consecutive gaps close to it.
      const rounded = gaps.map(g => Math.round(g));
      const freq = new Map();
      rounded.forEach(g => freq.set(g, (freq.get(g) || 0) + 1));
      let modeVal = rounded[0], modeCount = 0;
      freq.forEach((c, v) => { if(c > modeCount){ modeCount = c; modeVal = v; } });
      const tol = Math.max(2, modeVal * 0.15);
      let runStart = -1, bestStart = -1, bestEnd = -1;
      for(let i = 0; i < gaps.length; i++){
        if(Math.abs(gaps[i] - modeVal) <= tol){
          if(runStart === -1) runStart = i;
          if(bestStart === -1 || (i - runStart) > (bestEnd - bestStart)){ bestStart = runStart; bestEnd = i; }
        } else {
          runStart = -1;
        }
      }
      if(bestStart !== -1){
        start = candStart + bestStart;
        end = candStart + bestEnd + 1;
      }
    }

    let curStart = start, curEnd = end, core = null;
    // Re-detect on the shrinking range until it stabilizes: each pass may
    // reveal that a few rows at either end still don't fit the grid the
    // detector actually found (e.g. a short-text row that isn't really
    // part of the table), so shrink to just the fitting rows and retry.
    // Bounded iteration count since each pass only shrinks, never grows.
    for(let iter = 0; iter < 4; iter++){
      const range = rows.slice(curStart, curEnd + 1);
      core = tryBuildTableBlockCore(range);
      if(!core) return null;
      const rs = core.rowFits.indexOf(true);
      const re = core.rowFits.lastIndexOf(true);
      if(rs === -1) return null;
      const newStart = curStart + rs;
      const newEnd = curStart + re;
      if(newStart === curStart && newEnd === curEnd) break;
      curStart = newStart; curEnd = newEnd;
    }
    if(!core) return null;
    return { table: core, preRows: rows.slice(0, curStart), postRows: rows.slice(curEnd + 1) };
  }

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    progress.style.display = "block"; progress.value = 0;
    try{
      setStatus(status, "กำลังโหลดโมดูลแปลงไฟล์...", "loading");
      await loadScriptOnce("vendor/docx.umd.min.js");

      setStatus(status, "กำลังเปิดไฟล์ PDF...", "loading");
      const pdfDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      const numPages = pdfDoc.numPages;

      // Gather rows per page first so we can compute a document-wide median
      // font size (used to guess which rows are heading-like).
      const pagesRows = [];
      let allFontSizes = [];
      for(let p=1; p<=numPages; p++){
        setStatus(status, `กำลังอ่านข้อความหน้า ${p}/${numPages}...`, "loading");
        const page = await pdfDoc.getPage(p);
        const textContent = await page.getTextContent();
        const pageWidth = page.getViewport({ scale: 1 }).width;
        const { rows, splitIndex } = splitIntoColumnsAndGroupRows(textContent.items, pageWidth);
        pagesRows.push({ rows, splitIndex });
        rows.forEach(r => allFontSizes.push(r.maxFontSize));
        progress.value = Math.round((p/numPages)*40);
        await new Promise(r=>setTimeout(r,0));
      }

      const totalChars = pagesRows.reduce((sum, p)=> sum + p.rows.reduce((s,r)=> s + joinRowText(r.items).length, 0), 0);
      if(totalChars === 0){
        throw new Error("ไม่พบข้อความในไฟล์นี้ (อาจเป็น PDF ที่สแกนจากภาพ) ลองใช้เมนู \"OCR อ่านข้อความ\" ก่อน แล้วค่อยแปลงเป็น Word");
      }

      allFontSizes.sort((a,b)=>a-b);
      const medianFontSize = allFontSizes.length ? allFontSizes[Math.floor(allFontSizes.length/2)] : 11;

      setStatus(status, "กำลังจัดเรียงข้อความเป็นเอกสาร Word...", "loading");
      const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = docx;
      const docChildren = [];

      const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
      const TABLE_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER, insideHorizontal: CELL_BORDER, insideVertical: CELL_BORDER };
      function buildTableElement(table){
        const colWidthTwip = Math.max(500, Math.round((9000) / table.numCols));
        const rows = table.cellTexts.map((cells, ri)=> new TableRow({
          children: cells.map(text => new TableCell({
            width: { size: colWidthTwip, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: [ new Paragraph({ children: [ new TextRun({
              text: text || "",
              font: "Tahoma",
              size: Math.max(16, Math.min(28, Math.round((table.avgFontSize || 11) * 2))),
              bold: ri === 0,
            }) ] }) ],
          })),
        }));
        return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS });
      }

      // Base page size on the first page, converting PDF points -> twips
      // (1pt = 20 twips) so the Word page roughly matches the PDF's proportions.
      const firstViewport = (await pdfDoc.getPage(1)).getViewport({ scale: 1 });
      const pageWidthTwip = Math.max(1, Math.round(firstViewport.width * 20));
      const pageHeightTwip = Math.max(1, Math.round(firstViewport.height * 20));

      // Renders a run of rows as ordinary paragraphs (heading-like rows get
      // bold + extra spacing). `pageBreakFirst` puts the page-break marker
      // on the very first paragraph emitted; `blankBefore` inserts one
      // blank paragraph before the run starts (used between blocks/table
      // trim-offs so the spacing the source had isn't lost).
      function emitRowsAsParagraphs(rowsArr, pageBreakFirst, blankBefore){
        if(!rowsArr.length) return;
        if(blankBefore) docChildren.push(new Paragraph({ text: "" }));
        rowsArr.forEach((row, i)=>{
          const text = joinRowText(row.items);
          const fontSize = row.maxFontSize || medianFontSize;
          const isHeadingLike = fontSize >= medianFontSize * 1.25 && fontSize - medianFontSize >= 1.5;
          docChildren.push(new Paragraph({
            pageBreakBefore: pageBreakFirst && i === 0,
            spacing: isHeadingLike ? { before: 160, after: 80 } : undefined,
            children: [ new TextRun({
              text: text || " ",
              font: "Tahoma",
              size: Math.max(16, Math.min(96, Math.round(fontSize * 2))),
              bold: isHeadingLike,
            }) ],
          }));
        });
      }

      pagesRows.forEach(({ rows, splitIndex }, pageIdx)=>{
        if(rows.length === 0){
          docChildren.push(new Paragraph({ text: "", pageBreakBefore: pageIdx > 0 }));
          return;
        }
        const blocks = groupRowsIntoBlocks(rows, splitIndex);
        blocks.forEach((block, blockIdx)=>{
          const isFirstOfPage = pageIdx > 0 && blockIdx === 0;
          const blockNeedsLeadingBlank = blockIdx > 0;
          const found = tryBuildTableBlock(block);
          if(found){
            emitRowsAsParagraphs(found.preRows, isFirstOfPage, blockNeedsLeadingBlank);
            const tableIsFirst = isFirstOfPage && found.preRows.length === 0;
            const tableNeedsBlank = blockNeedsLeadingBlank && found.preRows.length === 0;
            if(tableIsFirst) docChildren.push(new Paragraph({ text: "", pageBreakBefore: true }));
            else if(tableNeedsBlank) docChildren.push(new Paragraph({ text: "" }));
            docChildren.push(buildTableElement(found.table));
            emitRowsAsParagraphs(found.postRows, false, found.postRows.length > 0);
            return;
          }
          emitRowsAsParagraphs(block, isFirstOfPage, blockNeedsLeadingBlank);
        });
      });

      const wordDoc = new Document({
        sections: [{
          properties: {
            page: { size: { width: pageWidthTwip, height: pageHeightTwip }, margin: { top: 720, bottom: 720, left: 720, right: 720 } },
          },
          children: docChildren,
        }],
      });

      progress.value = 70;
      const blob = await Packer.toBlob(wordDoc);
      progress.value = 100;
      outputBlob = blob;
      const pagesWithText = pagesRows.filter(p=>p.rows.length>0).length;
      result.querySelector(".stats").innerHTML = `ดึงข้อความแล้ว <b>${pagesWithText}</b>/<b>${numPages}</b> หน้า · <b>${totalChars.toLocaleString("th-TH")}</b> ตัวอักษร · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, fileName);
      result.classList.add("show");
      setStatus(status, "แปลงเป็น Word สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    progress.style.display = "none";
    runBtn.disabled = false;
  };

  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, fileName, ".docx")); };
})();

/* ================= EXCEL TO PDF ================= */
(function(){
  const drop = document.getElementById("excelpdf-drop");
  const input = document.getElementById("excelpdf-input");
  const body = document.getElementById("excelpdf-body");
  const filenameEl = document.getElementById("excelpdf-filename");
  const removeBtn = document.getElementById("excelpdf-remove");
  const runBtn = document.getElementById("excelpdf-run");
  const progress = document.getElementById("excelpdf-progress");
  const status = document.getElementById("excelpdf-status");
  const result = document.getElementById("excelpdf-result");
  const downloadBtn = document.getElementById("excelpdf-download");
  const filenameInput = document.getElementById("excelpdf-filename-input");

  let buffer = null, fileName = "document", outputBlob = null;

  function reset(){
    buffer = null; outputBlob = null;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    if(!file) return;
    fileName = file.name.replace(/\.xlsx$/i, "");
    filenameEl.textContent = file.name;
    buffer = await readFileAsArrayBuffer(file);
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, "", "");
  }, [".xlsx"]);

  removeBtn.onclick = reset;

  runBtn.onclick = async ()=>{
    if(!buffer) return;
    runBtn.disabled = true;
    progress.style.display = "block"; progress.value = 0;
    const container = document.createElement("div");
    container.style.cssText = "position:fixed; left:-99999px; top:0; z-index:-1; width:1000px; background:#fff;";
    document.body.appendChild(container);
    try{
      setStatus(status, "กำลังโหลดโมดูลแปลงไฟล์...", "loading");
      await loadScriptOnce("vendor/xlsx.min.js");
      await loadScriptOnce("vendor/html2canvas.min.js");

      setStatus(status, "กำลังอ่านไฟล์ Excel...", "loading");
      const wb = XLSX.read(new Uint8Array(buffer), { type:"array" });
      const sheetNames = wb.SheetNames || [];
      if(!sheetNames.length) throw new Error("ไม่พบชีตในไฟล์");

      // Browsers refuse (or silently blank out) a <canvas> once its pixel
      // area gets too large — roughly 268 million px² in Chrome. A sheet
      // with many rows, rasterized whole at html2canvas's scale:2, easily
      // blows past that (e.g. 2000 x 165754 px ≈ 331M px² for ~3000 rows),
      // and the result is a canvas that "succeeds" but paints solid black
      // once flattened to JPEG — matching the exported-PDF symptom. The fix
      // is to never rasterize a whole large sheet in one shot: split it
      // into row-chunks sized to roughly one PDF page's worth of content
      // each, and render/paginate one chunk at a time.
      const PAGE_W_PT = 595.28, PAGE_H_PT = 841.89, MARGIN_PT = 24;
      const CONTENT_W_PT = PAGE_W_PT - MARGIN_PT*2;
      const CONTENT_H_PT = PAGE_H_PT - MARGIN_PT*2;
      const SCALE = 2;

      const outDoc = await PDFDocument.create();
      for(let i=0;i<sheetNames.length;i++){
        setStatus(status, `กำลังแปลงชีต "${sheetNames[i]}" (${i+1}/${sheetNames.length})...`, "loading");
        const sheet = wb.Sheets[sheetNames[i]];
        const htmlStr = XLSX.utils.sheet_to_html(sheet, { id: "jexcel-sheet-table", editable: false });
        container.innerHTML = `<div style="font-family:Arial,Helvetica,sans-serif; padding:16px; color:#111;">
          <h3 style="margin:0 0 10px; font-size:16px;">${escapeHtml(sheetNames[i])}</h3>
          ${htmlStr}
        </div>`;
        const table = container.querySelector("table");
        if(table){
          table.style.borderCollapse = "collapse";
          table.style.fontSize = "12px";
          table.querySelectorAll("td, th").forEach(cell=>{
            cell.style.border = "1px solid #999";
            cell.style.padding = "4px 6px";
          });
        }

        const rows = table ? Array.from(table.rows) : [];
        // How much CSS-px height of table content corresponds to one PDF
        // page's content area, given the width the table will render at.
        // (The render scale factor cancels out of this ratio, so it's the
        // same math addCanvasAsPdfPages uses to fit width-to-page.) Each
        // rendered chunk is wrapped in a div with 16px top+bottom padding
        // (32px total), and the first chunk also carries the sheet-name
        // heading — both need to be subtracted from the row budget, or
        // every chunk ends up a hair taller than one page and gets an
        // extra near-empty page tacked on by addCanvasAsPdfPages.
        const containerCssW = Math.max(1, container.getBoundingClientRect().width);
        const pageBudgetCssPx = CONTENT_H_PT * containerCssW / CONTENT_W_PT;
        const WRAP_PAD_CSS_PX = 32;
        const headingEl = container.querySelector("h3");
        const headingCssPx = headingEl ? headingEl.getBoundingClientRect().height + 10 : 0;
        // small safety margin against sub-pixel/rounding drift
        const firstChunkBudget = Math.max(50, (pageBudgetCssPx - WRAP_PAD_CSS_PX - headingCssPx) * 0.98);
        const restChunkBudget = Math.max(50, (pageBudgetCssPx - WRAP_PAD_CSS_PX) * 0.98);

        if(!table || rows.length === 0){
          const canvas = await html2canvas(container, { scale: SCALE, backgroundColor: "#ffffff", logging: false });
          await addCanvasAsPdfPages(outDoc, canvas, {});
        }else{
          // Group rows into chunks that each fit within ~1 page's height
          // budget (a lone row taller than a full page becomes its own
          // chunk and gets sliced across multiple pages as a fallback).
          const chunks = [];
          let cur = [], curH = 0, budget = firstChunkBudget;
          rows.forEach(tr=>{
            const h = tr.getBoundingClientRect().height || 20;
            if(cur.length && curH + h > budget){
              chunks.push(cur);
              cur = []; curH = 0;
              budget = restChunkBudget; // only the very first chunk carries the heading
            }
            cur.push(tr); curH += h;
          });
          if(cur.length) chunks.push(cur);

          for(let c=0;c<chunks.length;c++){
            const chunkTable = document.createElement("table");
            chunkTable.style.cssText = table.style.cssText;
            chunks[c].forEach(tr=> chunkTable.appendChild(tr.cloneNode(true)));
            const wrap = document.createElement("div");
            wrap.style.cssText = "font-family:Arial,Helvetica,sans-serif; padding:16px; color:#111;";
            if(c === 0){
              const h3 = document.createElement("h3");
              h3.style.cssText = "margin:0 0 10px; font-size:16px;";
              h3.textContent = sheetNames[i];
              wrap.appendChild(h3);
            }
            wrap.appendChild(chunkTable);
            container.innerHTML = "";
            container.appendChild(wrap);
            const canvas = await html2canvas(container, { scale: SCALE, backgroundColor: "#ffffff", logging: false });
            await addCanvasAsPdfPages(outDoc, canvas, {});
            await new Promise(r=>setTimeout(r,0));
          }
        }
        progress.value = Math.round(((i+1)/sheetNames.length)*100);
        await new Promise(r=>setTimeout(r,0));
      }
      const bytes = await outDoc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `แปลงแล้ว <b>${sheetNames.length}</b> ชีต · <b>${outDoc.getPageCount()}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, fileName);
      result.classList.add("show");
      setStatus(status, "แปลงเป็น PDF สำเร็จ", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    document.body.removeChild(container);
    progress.style.display = "none";
    runBtn.disabled = false;
  };

  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, fileName, ".pdf")); };
})();

/* ================= HTML TO PDF ================= */
(function(){
  const drop = document.getElementById("htmlpdf-drop");
  const input = document.getElementById("htmlpdf-input");
  const body = document.getElementById("htmlpdf-body");
  const filenameEl = document.getElementById("htmlpdf-filename");
  const removeBtn = document.getElementById("htmlpdf-remove");
  const runBtn = document.getElementById("htmlpdf-run");
  const progress = document.getElementById("htmlpdf-progress");
  const status = document.getElementById("htmlpdf-status");
  const result = document.getElementById("htmlpdf-result");
  const downloadBtn = document.getElementById("htmlpdf-download");
  const filenameInput = document.getElementById("htmlpdf-filename-input");

  let htmlText = null, fileName = "document", outputBlob = null;

  function reset(){
    htmlText = null; outputBlob = null;
    body.style.display = "none";
    input.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    if(!file) return;
    fileName = file.name.replace(/\.html?$/i, "");
    filenameEl.textContent = file.name;
    htmlText = await file.text();
    body.style.display = "block";
    result.classList.remove("show");
    setStatus(status, "", "");
  }, [".html", ".htm"]);

  removeBtn.onclick = reset;

  runBtn.onclick = async ()=>{
    if(htmlText == null) return;
    runBtn.disabled = true;
    progress.style.display = "block"; progress.value = 20;
    let iframe = null;
    try{
      setStatus(status, "กำลังโหลดโมดูลแปลงไฟล์...", "loading");
      await loadScriptOnce("vendor/html2canvas.min.js");

      setStatus(status, "กำลังโหลดหน้า HTML เพื่อแสดงผล...", "loading");
      iframe = document.createElement("iframe");
      // allow-same-origin only (no allow-scripts): the page renders CSS/HTML
      // normally so it looks the same as opening the file directly, but any
      // <script> tag inside the uploaded file is blocked from running.
      iframe.setAttribute("sandbox", "allow-same-origin");
      iframe.style.cssText = "position:fixed; left:-99999px; top:0; width:900px; height:600px; border:0;";
      document.body.appendChild(iframe);
      await new Promise((resolve, reject)=>{
        iframe.onload = resolve;
        iframe.onerror = ()=> reject(new Error("โหลดไฟล์ HTML ไม่สำเร็จ"));
        iframe.srcdoc = htmlText;
      });
      await new Promise(r=> setTimeout(r, 400));
      const idoc = iframe.contentDocument;
      if(!idoc) throw new Error("ไม่สามารถอ่านเนื้อหาไฟล์ HTML ได้");
      if(idoc.fonts && idoc.fonts.ready){ try{ await idoc.fonts.ready; }catch(e){} }
      const targetEl = idoc.body || idoc.documentElement;
      const fullHeight = Math.max(
        idoc.body ? idoc.body.scrollHeight : 0,
        idoc.documentElement ? idoc.documentElement.scrollHeight : 0,
        600
      );
      iframe.style.height = fullHeight + "px";
      await new Promise(r=> setTimeout(r, 50));

      progress.value = 60;
      setStatus(status, "กำลังแปลงเป็น PDF...", "loading");
      const canvas = await html2canvas(targetEl, { scale: 2, backgroundColor: "#ffffff", logging: false, windowWidth: 900 });

      const outDoc = await PDFDocument.create();
      const pageCount = await addCanvasAsPdfPages(outDoc, canvas, {});
      const bytes = await outDoc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `แปลงแล้ว <b>${pageCount}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
      setFilenameDefault(filenameInput, fileName);
      result.classList.add("show");
      setStatus(status, "แปลงเป็น PDF สำเร็จ", "ok");
      progress.value = 100;
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    if(iframe && iframe.parentNode) document.body.removeChild(iframe);
    progress.style.display = "none";
    runBtn.disabled = false;
  };

  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, resolveFilename(filenameInput, fileName, ".pdf")); };
})();

