pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
const { PDFDocument, StandardFonts, rgb, degrees, PageSizes, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream } = PDFLib;

/* ================= THEME TOGGLE (light/dark) ================= */
(function(){
  const THEME_KEY = "acrobeer-theme";
  const btn = document.getElementById("theme-toggle");
  if(!btn) return;
  function currentTheme(){
    let saved = null;
    try{ saved = localStorage.getItem(THEME_KEY); }catch(e){}
    if(saved === "light" || saved === "dark") return saved;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
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
const _escapeHtmlMap = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c)=>_escapeHtmlMap[c]);
}
function setStatus(el, msg, kind){
  el.className = "status" + (kind ? " " + kind : "");
  // msg is always treated as plain text (escaped) — only the loading spinner markup is trusted HTML.
  el.innerHTML = (kind === "loading" ? '<span class="spinner"></span>' : '') + escapeHtml(msg);
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

/* ---------- tabs ---------- */
document.querySelectorAll("nav.tabs button").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    document.dispatchEvent(new CustomEvent("pdftools:tabchange", { detail: { tab: btn.dataset.tab } }));
  });
});

/* ---------- responsive tab bar: auto-collapse to icon-only if it would overflow ---------- */
(function(){
  const nav = document.querySelector("nav.tabs");
  if(!nav) return;
  function fitTabs(){
    nav.classList.remove("tight", "snug", "compact");
    if(nav.scrollWidth > nav.clientWidth + 1){
      nav.classList.add("tight");
      if(nav.scrollWidth > nav.clientWidth + 1){
        nav.classList.remove("tight");
        nav.classList.add("snug");
        if(nav.scrollWidth > nav.clientWidth + 1){
          nav.classList.remove("snug");
          nav.classList.add("compact");
        }
      }
    }
  }
  fitTabs();
  window.addEventListener("resize", fitTabs);
  window.addEventListener("load", fitTabs);
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(fitTabs).catch(()=>{});
  }
  setTimeout(fitTabs, 300);
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

/* ================= MERGE ================= */
(function(){
  const drop = document.getElementById("merge-drop");
  const input = document.getElementById("merge-input");
  const list = document.getElementById("merge-list");
  const runBtn = document.getElementById("merge-run");
  const clearBtn = document.getElementById("merge-clear");
  const status = document.getElementById("merge-status");
  const result = document.getElementById("merge-result");
  const downloadBtn = document.getElementById("merge-download");
  let items = [];
  let outputBlob = null;

  function render(){
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
    result.classList.remove("show"); outputBlob = null;
  }

  async function addFiles(files){
    for(const file of files){
      const buf = await readFileAsArrayBuffer(file);
      try{
        const srcDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption:true });
        const pageCount = srcDoc.getPageCount();
        let thumbCanvas = null;
        try{ thumbCanvas = (await renderPageCanvas(buf, 1, 88)).canvas; }catch(e){}
        items.push({ file, buffer: buf, pageCount, thumbCanvas });
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
      const out = await PDFDocument.create();
      for(const it of items){
        const src = await PDFDocument.load(it.buffer.slice(0), { ignoreEncryption:true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p=>out.addPage(p));
      }
      const bytes = await out.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      setStatus(status, "รวมไฟล์สำเร็จ", "ok");
      result.querySelector(".stats").innerHTML = `<b>${out.getPageCount()}</b> หน้า รวม · <b>${fmtBytes(outputBlob.size)}</b>`;
      result.classList.add("show");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
    runBtn.disabled = items.length < 2;
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, "merged.pdf"); };
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
  const removeBtn = document.getElementById("split-remove");
  let buffer = null, fileName = "document", numPages = 0, selected = new Set();
  let outputBlob = null, outputName = "";

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
      const src = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      if(modeSel.value === "single"){
        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, pages.map(p=>p-1));
        copied.forEach(p=>out.addPage(p));
        const bytes = await out.save();
        outputBlob = new Blob([bytes], { type:"application/pdf" });
        outputName = `${fileName}_extracted.pdf`;
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
        outputName = `${fileName}_pages.zip`;
        result.querySelector(".stats").innerHTML = `<b>${pages.length}</b> ไฟล์ในชุด ZIP · <b>${fmtBytes(outputBlob.size)}</b>`;
      }
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
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, outputName); };
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
      const srcLib = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
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
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_compressed.pdf`); };
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
      const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
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
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_numbered.pdf`); };
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
  const removeBtn = document.getElementById("watermark-remove");
  const previewPlaceholder = document.getElementById("watermark-preview-placeholder");
  const previewCanvas = document.getElementById("watermark-preview");
  let buffer = null, fileName = "document", outputBlob = null;
  let basePageCanvas = null, pageScale = 1;

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
    const cax = previewCanvas.width / 2 - textWidthPx / 2;
    const cay = previewCanvas.height / 2;
    ctx.translate(cax, cay);
    ctx.rotate(-rotation * Math.PI / 180);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function resetPreview(){
    basePageCanvas = null;
    previewCanvas.style.display = "none";
    previewPlaceholder.style.display = "flex";
  }

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
    try{
      const { canvas: baseCanvas, scale } = await renderPageCanvas(buffer, 1, 220);
      basePageCanvas = baseCanvas;
      pageScale = scale;
      previewCanvas.width = baseCanvas.width;
      previewCanvas.height = baseCanvas.height;
      previewPlaceholder.style.display = "none";
      previewCanvas.style.display = "block";
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
      const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(thaiFontBytes(), { subset: true });
      const text = textInput.value || "WATERMARK";
      const size = parseFloat(sizeRange.value);
      const opacity = parseInt(opRange.value,10) / 100;
      const rotation = parseFloat(rotRange.value);
      const { r,g,b } = hexToRgb01(colorInput.value);
      const textWidth = font.widthOfTextAtSize(text, size);
      doc.getPages().forEach(page=>{
        const { width, height } = page.getSize();
        page.drawText(text, {
          x: width/2 - textWidth/2,
          y: height/2,
          size, font, color: rgb(r,g,b), opacity,
          rotate: degrees(rotation),
        });
      });
      const bytes = await doc.save();
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `<b>${doc.getPageCount()}</b> หน้า · <b>${fmtBytes(outputBlob.size)}</b>`;
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
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_watermarked.pdf`); };
})();


/* ================= QUICK EDIT (client-side overlay, no install) ================= */
(function(){
  const drop = document.getElementById("quickedit-drop");
  const input = document.getElementById("quickedit-input");
  const body = document.getElementById("quickedit-body");
  const filenameEl = document.getElementById("quickedit-filename");
  const removeBtn = document.getElementById("quickedit-remove");
  const prevBtn = document.getElementById("quickedit-prev");
  const nextBtn = document.getElementById("quickedit-next");
  const pageIndicator = document.getElementById("quickedit-page-indicator");
  const stageEl = document.getElementById("quickedit-stage");
  const canvasEl = document.getElementById("quickedit-canvas");
  const textLayerEl = document.getElementById("quickedit-textlayer");
  const downloadBtn = document.getElementById("quickedit-download");
  const resetBtn = document.getElementById("quickedit-reset-edits");
  const status = document.getElementById("quickedit-status");
  const popover = document.getElementById("quickedit-popover");
  const textarea = document.getElementById("quickedit-textarea");
  const fontsizeInput = document.getElementById("quickedit-fontsize");
  const fontSelect = document.getElementById("quickedit-fontfamily");
  const boldCheckbox = document.getElementById("quickedit-bold");
  const colorInput = document.getElementById("quickedit-color");
  const applyBtn = document.getElementById("quickedit-apply");
  const cancelBtn = document.getElementById("quickedit-cancel");
  if(!drop || !input) return;

  const RENDER_WIDTH = 720;
  let originalBuffer = null, fileName = "document";
  let workingDoc = null, workingBytes = null;
  let qeFontCache = {};
  let currentPage = 1, numPages = 1, pageScale = 1;
  let activeItem = null, activeDiv = null;
  let lastFontKey = "loma";
  let lastBold = false;

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
      opt.value = "loma"; opt.textContent = "Loma (ค่าเริ่มต้น)";
      fontSelect.appendChild(opt);
    }
  }
  populateFontSelect();
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
      const pxLeft = Math.max(0, Math.floor(x0*pageScale));
      const pxRight = Math.min(canvasEl.width, Math.ceil((x0+width)*pageScale));
      const pyTop = Math.max(0, Math.floor(canvasEl.height - (y0+ascent)*pageScale));
      const pyBottom = Math.min(canvasEl.height, Math.ceil(canvasEl.height - (y0-descent)*pageScale));
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

  function resetState(){
    originalBuffer = null; workingDoc = null; workingBytes = null; qeFontCache = {};
    currentPage = 1; numPages = 1;
    textLayerEl.innerHTML = "";
    const ctx = canvasEl.getContext("2d");
    ctx.clearRect(0,0,canvasEl.width,canvasEl.height);
    closePopover();
  }

  function closePopover(){
    if(activeDiv) activeDiv.classList.remove("editing");
    activeItem = null; activeDiv = null;
    popover.classList.add("hidden");
  }

  function openPopover(item, div){
    activeItem = item; activeDiv = div;
    div.classList.add("editing");
    textarea.value = item.str;
    const approxSize = Math.hypot(item.transform[2], item.transform[3]) || 12;
    fontsizeInput.value = Math.round(approxSize*10)/10;
    fontSelect.value = lastFontKey;
    if(fontSelect.value !== lastFontKey && fontSelect.options.length) fontSelect.selectedIndex = 0;
    if(boldCheckbox) boldCheckbox.checked = lastBold;
    const tx0 = item.transform;
    const bg0 = sampleBgColor(tx0[4], tx0[5], approxSize);
    const ink0 = sampleInkColor(item, bg0);
    colorInput.value = rgbToHex(ink0);
    popover.classList.remove("hidden");
    const r = div.getBoundingClientRect();
    const popW = 280;
    let left = r.left;
    if(left + popW > window.innerWidth - 16) left = window.innerWidth - popW - 16;
    left = Math.max(8, left);
    popover.style.left = left + "px";
    popover.style.top = (r.bottom + 8) + "px";
    requestAnimationFrame(()=>{
      const pr = popover.getBoundingClientRect();
      if(pr.bottom > window.innerHeight - 8){
        popover.style.top = Math.max(8, r.top - pr.height - 8) + "px";
      }
    });
    textarea.focus();
    textarea.select();
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
      const maxAscent = nominalAscent * 1.8 + 4;
      const maxDescent = nominalDescent * 2.2 + 4;
      const pxLeft = Math.max(0, Math.floor(x0*pageScale) - 1);
      const pxRight = Math.min(canvasEl.width, Math.ceil((x0+width)*pageScale) + 1);
      const pyTop = Math.max(0, Math.floor(canvasEl.height - (yBaseline+maxAscent)*pageScale));
      const pyBottom = Math.min(canvasEl.height, Math.ceil(canvasEl.height - (yBaseline-maxDescent)*pageScale));
      const w = Math.max(1, pxRight-pxLeft), h = Math.max(1, pyBottom-pyTop);
      if(w < 1 || h < 1) return { ascent: nominalAscent, descent: nominalDescent };
      const data = canvasEl.getContext("2d").getImageData(pxLeft, pyTop, w, h).data;
      const bgR = bg.r*255, bgG = bg.g*255, bgB = bg.b*255;
      let firstInkRow = -1, lastInkRow = -1;
      for(let row=0; row<h; row++){
        let hasInk = false;
        for(let col=0; col<w; col++){
          const idx = (row*w+col)*4;
          const d = Math.abs(data[idx]-bgR) + Math.abs(data[idx+1]-bgG) + Math.abs(data[idx+2]-bgB);
          if(d > 12){ hasInk = true; break; }
        }
        if(hasInk){
          if(firstInkRow === -1) firstInkRow = row;
          lastInkRow = row;
        }
      }
      if(firstInkRow === -1) return { ascent: nominalAscent, descent: nominalDescent };
      // pad a couple pixels beyond the detected ink to fully swallow
      // anti-aliased edge pixels that fall just under the threshold
      const topPxAbs = Math.max(0, pyTop + firstInkRow - 2);
      const bottomPxAbs = Math.min(canvasEl.height, pyTop + lastInkRow + 1 + 2);
      const topPdfY = (canvasEl.height - topPxAbs) / pageScale;
      const bottomPdfY = (canvasEl.height - bottomPxAbs) / pageScale;
      return {
        ascent: Math.max(nominalAscent, topPdfY - yBaseline),
        descent: Math.max(nominalDescent, yBaseline - bottomPdfY),
      };
    }catch(e){ return { ascent: nominalAscent, descent: nominalDescent }; }
  }

  function sampleBgColor(xPdf, yBaselinePdf, fontSize){
    try{
      const px = Math.min(Math.max(0, Math.round(xPdf * pageScale) - 3), canvasEl.width - 1);
      const py = Math.min(Math.max(0, Math.round(canvasEl.height - (yBaselinePdf + fontSize*0.95) * pageScale) - 3), canvasEl.height - 1);
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
      div.addEventListener("click", (e)=>{ e.stopPropagation(); openPopover(item, div); });
    });

    pageIndicator.textContent = `หน้า ${currentPage} / ${numPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= numPages;
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i, "");
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    setStatus(status, "กำลังเปิดไฟล์...", "loading");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
      workingDoc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      workingBytes = originalBuffer.slice(0);
      currentPage = 1;
      await renderCurrentPage();
      setStatus(status, "", "");
    }catch(e){
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

  applyBtn.onclick = async ()=>{
    if(!activeItem || !workingDoc) return;
    const item = activeItem;
    const newText = textarea.value;
    const size = parseFloat(fontsizeInput.value) || Math.hypot(item.transform[2], item.transform[3]) || 12;
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
      page.drawRectangle({
        x: x - 1, y: yBaseline - inkExtent.descent, width: width + 3, height: inkExtent.descent + inkExtent.ascent,
        color: rgb(fill.r, fill.g, fill.b),
      });
      if(newText.trim() !== ""){
        const baseKey = fontSelect.value || "loma";
        const wantBold = !!(boldCheckbox && boldCheckbox.checked);
        lastFontKey = baseKey;
        lastBold = wantBold;
        const fontKey = resolveFontKey(baseKey, wantBold);
        const font = await getEmbeddedFont(fontKey);
        const { r: tr, g: tg, b: tb } = hexToRgb01(colorInput.value);
        page.drawText(newText, { x, y: yBaseline, size, font, color: rgb(tr, tg, tb) });
      }
      workingBytes = await workingDoc.save();
      await renderCurrentPage();
      setStatus(status, "บันทึกการแก้ไขแล้ว", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };
  cancelBtn.onclick = closePopover;
  document.addEventListener("click", (e)=>{
    if(!popover.classList.contains("hidden") && !popover.contains(e.target) && !e.target.closest(".qe-box")){
      closePopover();
    }
  });
  popover.addEventListener("click", (e)=> e.stopPropagation());

  resetBtn.onclick = async ()=>{
    if(!originalBuffer) return;
    setStatus(status, "กำลังล้างการแก้ไข...", "loading");
    try{
      workingDoc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      workingDoc.registerFontkit(fontkit);
      qeFontCache = {};
      workingBytes = originalBuffer.slice(0);
      currentPage = 1;
      await renderCurrentPage();
      setStatus(status, "เริ่มใหม่จากไฟล์เดิมแล้ว", "ok");
    }catch(e){
      setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
    }
  };

  downloadBtn.onclick = ()=>{
    if(!workingBytes) return;
    const blob = new Blob([workingBytes], { type: "application/pdf" });
    downloadBlob(blob, `${fileName}_edited.pdf`);
  };

  removeBtn.onclick = ()=>{
    resetState();
    body.style.display = "none";
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

  const prevBtn = document.getElementById("signature-prev");
  const nextBtn = document.getElementById("signature-next");
  const pageIndicator = document.getElementById("signature-page-indicator");
  const stageEl = document.getElementById("signature-stage");
  const canvasEl = document.getElementById("signature-canvas");
  const overlayEl = document.getElementById("signature-overlay");
  const overlayImg = document.getElementById("signature-overlay-img");
  const handleEl = document.getElementById("signature-handle");

  const addBtn = document.getElementById("signature-add");
  const placementsEl = document.getElementById("signature-placements");
  const downloadBtn = document.getElementById("signature-download");
  const resetBtn = document.getElementById("signature-reset");
  const status = document.getElementById("signature-status");
  if(!drop || !input) return;

  const RENDER_WIDTH = 720;
  let originalBuffer = null, fileName = "document";
  let currentPage = 1, numPages = 1, pageScale = 1;
  let sigImageBytes = null, sigImageMime = null, sigImageAspect = 1, sigImageUrl = null;
  let placements = [];

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
    body.style.display = "block";
    setStatus(status, "กำลังเปิดไฟล์...", "loading");
    try{
      originalBuffer = await readFileAsArrayBuffer(file);
      currentPage = 1;
      placements = []; renderPlacementsList();
      await renderCurrentPage(false);
      setStatus(status, "", "");
    }catch(e){
      setStatus(status, "เปิดไฟล์ไม่สำเร็จ: " + e.message, "err");
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
      sigImageBytes = new Uint8Array(buf);
      sigImageMime = (file.type === "image/jpeg" || file.type === "image/jpg") ? "image/jpeg" : "image/png";
      if(sigImageUrl) URL.revokeObjectURL(sigImageUrl);
      sigImageUrl = URL.createObjectURL(new Blob([buf], { type: sigImageMime }));
      const dim = await new Promise((resolve, reject)=>{
        const im = new Image();
        im.onload = ()=> resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
        im.onerror = ()=> reject(new Error("ไม่สามารถอ่านรูปภาพนี้ได้"));
        im.src = sigImageUrl;
      });
      sigImageAspect = dim.w / dim.h || 1;
      overlayImg.src = sigImageUrl;
      imgThumb.innerHTML = "";
      const thumbImg = document.createElement("img");
      thumbImg.src = sigImageUrl;
      imgThumb.appendChild(thumbImg);
      imgTitle.textContent = file.name;
      imgSub.textContent = `${dim.w}×${dim.h}px · ${fmtBytes(file.size)}`;
      imgChooseBtn.textContent = "เปลี่ยนรูป";
      imgRemoveBtn.style.display = "inline-flex";
      if(originalBuffer){
        overlayEl.classList.remove("hidden");
        placeOverlayDefault();
      }
      setStatus(status, "", "");
    }catch(e){
      setStatus(status, "อัปโหลดรูปลายเซ็นไม่สำเร็จ: " + e.message, "err");
    }
  });
  imgRemoveBtn.onclick = ()=>{
    sigImageBytes = null; sigImageMime = null;
    if(sigImageUrl){ URL.revokeObjectURL(sigImageUrl); sigImageUrl = null; }
    overlayImg.removeAttribute("src");
    imgThumb.innerHTML = THUMB_PLACEHOLDER;
    imgTitle.textContent = "ยังไม่ได้เลือกรูปลายเซ็น";
    imgSub.textContent = "แนะนำไฟล์ PNG พื้นหลังโปร่งใส";
    imgChooseBtn.textContent = "เลือกรูป";
    imgRemoveBtn.style.display = "none";
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

  downloadBtn.onclick = async ()=>{
    if(!originalBuffer){ setStatus(status, "กรุณาอัปโหลดไฟล์ PDF ก่อน", "err"); return; }
    if(!sigImageBytes){ setStatus(status, "กรุณาอัปโหลดรูปลายเซ็นก่อน", "err"); return; }
    if(!placements.length){ setStatus(status, "กรุณาเพิ่มลายเซ็นลงในหน้าอย่างน้อย 1 ตำแหน่งก่อน", "err"); return; }
    setStatus(status, "กำลังสร้างไฟล์...", "loading");
    try{
      const doc = await PDFDocument.load(originalBuffer.slice(0), { ignoreEncryption: true });
      const img = sigImageMime === "image/jpeg" ? await doc.embedJpg(sigImageBytes) : await doc.embedPng(sigImageBytes);
      placements.forEach(p=>{
        const page = doc.getPage(p.page - 1);
        page.drawImage(img, { x: p.x, y: p.y, width: p.width, height: p.height });
      });
      const bytes = await doc.save();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName}_signed.pdf`);
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
    downloadBlob(outputBlob, `${fileName}_protected.pdf`);
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
      setStatus(status, "ไม่สามารถอ่านไฟล์นี้ได้: " + e.message, "err");
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
      const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true });
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
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_rotated.pdf`); };
})();

/* ================= IMAGE <-> PDF ================= */
(function(){
  const modeGroup = document.getElementById("imgpdf-mode");
  const topdfSection = document.getElementById("imgpdf-topdf-section");
  const toimgSection = document.getElementById("imgpdf-toimg-section");

  modeGroup.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      modeGroup.querySelectorAll(".chip").forEach(c=>c.classList.remove("active"));
      chip.classList.add("active");
      const mode = chip.dataset.mode;
      topdfSection.style.display = mode === "toPdf" ? "block" : "none";
      toimgSection.style.display = mode === "toImg" ? "block" : "none";
    });
  });

  /* ---- images -> pdf ---- */
  (function(){
    const drop = document.getElementById("imgpdf-topdf-drop");
    const input = document.getElementById("imgpdf-topdf-input");
    const list = document.getElementById("imgpdf-topdf-list");
    const pagesizeSel = document.getElementById("imgpdf-pagesize");
    const runBtn = document.getElementById("imgpdf-topdf-run");
    const clearBtn = document.getElementById("imgpdf-topdf-clear");
    const status = document.getElementById("imgpdf-topdf-status");
    const result = document.getElementById("imgpdf-topdf-result");
    const downloadBtn = document.getElementById("imgpdf-topdf-download");
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
        result.classList.add("show");
        setStatus(status, "สร้างไฟล์ PDF สำเร็จ", "ok");
      }catch(e){
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
      runBtn.disabled = items.length === 0;
    };
    downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, "images.pdf"); };
  })();

  /* ---- pdf -> images ---- */
  (function(){
    const drop = document.getElementById("imgpdf-toimg-drop");
    const input = document.getElementById("imgpdf-toimg-input");
    const body = document.getElementById("imgpdf-toimg-body");
    const filenameEl = document.getElementById("imgpdf-toimg-filename");
    const removeBtn = document.getElementById("imgpdf-toimg-remove");
    const formatSel = document.getElementById("imgpdf-format");
    const scaleSel = document.getElementById("imgpdf-scale");
    const runBtn = document.getElementById("imgpdf-toimg-run");
    const progress = document.getElementById("imgpdf-toimg-progress");
    const status = document.getElementById("imgpdf-toimg-status");
    const result = document.getElementById("imgpdf-toimg-result");
    const downloadBtn = document.getElementById("imgpdf-toimg-download");
    let buffer = null, fileName = "document", outputBlob = null;

    wireDrop(drop, input, async (files)=>{
      const file = files[0];
      fileName = file.name.replace(/\.pdf$/i,"");
      buffer = await readFileAsArrayBuffer(file);
      filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
      body.style.display = "block";
      result.classList.remove("show");
      setStatus(status, "", "");
    });

    runBtn.onclick = async ()=>{
      if(!buffer) return;
      runBtn.disabled = true;
      progress.style.display = "block"; progress.value = 0;
      const format = formatSel.value;
      const scale = parseFloat(scaleSel.value);
      try{
        const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
        const n = pdfjsDoc.numPages;
        const zip = new JSZip();
        const ext = format === "jpeg" ? "jpg" : "png";
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";
        for(let i=1;i<=n;i++){
          setStatus(status, `กำลังแปลงหน้า ${i}/${n}...`, "loading");
          const page = await pdfjsDoc.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if(format === "jpeg"){ ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height); }
          await page.render({ canvasContext: ctx, viewport }).promise;
          const dataUrl = canvas.toDataURL(mime, format === "jpeg" ? 0.92 : undefined);
          const imgBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c=>c.charCodeAt(0));
          zip.file(`${fileName}_page_${String(i).padStart(3,"0")}.${ext}`, imgBytes);
          progress.value = Math.round((i/n)*100);
          await new Promise(r=>setTimeout(r,0));
        }
        outputBlob = await zip.generateAsync({ type:"blob" });
        result.querySelector(".stats").innerHTML = `<b>${n}</b> ไฟล์รูปภาพ · <b>${fmtBytes(outputBlob.size)}</b>`;
        result.classList.add("show");
        setStatus(status, "แปลงสำเร็จ", "ok");
      }catch(e){
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
      progress.style.display = "none";
      runBtn.disabled = false;
    };
    removeBtn.onclick = ()=>{
      buffer = null; outputBlob = null;
      body.style.display = "none";
      input.value = "";
      result.classList.remove("show");
      setStatus(status, "", "");
    };
    downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_images.zip`); };
  })();
})();

/* ================= REMOVE PASSWORD ================= */
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
  let buffer = null, fileName = "document", outputBlob = null, encInfo = null;

  // Standard 32-byte padding string (ISO 32000-2 Algorithm 2, Table 21)
  const PAD = Uint8Array.from([0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
    0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);

  function padPassword32(pwBytes){
    const out = new Uint8Array(32);
    const n = Math.min(pwBytes.length, 32);
    out.set(pwBytes.subarray(0,n));
    out.set(PAD.subarray(0, 32-n), n);
    return out;
  }
  function permBytesLE(p){
    return Uint8Array.from([p & 0xFF, (p>>8)&0xFF, (p>>16)&0xFF, (p>>24)&0xFF]);
  }
  function bytesEqualN(a,b,len){
    for(let i=0;i<len;i++) if(a[i]!==b[i]) return false;
    return true;
  }

  function computeFileKeyRC4FromPadded(paddedPwBytes, O, P, idBytes, keyLenBytes, R, encryptMetadata){
    let hashInput = PDFEncrypt.concat(paddedPwBytes, O, permBytesLE(P), idBytes);
    if(R >= 4 && encryptMetadata === false){
      hashInput = PDFEncrypt.concat(hashInput, Uint8Array.from([0xff,0xff,0xff,0xff]));
    }
    let hash = PDFEncrypt.md5(hashInput);
    if(R >= 3){
      for(let i=0;i<50;i++) hash = PDFEncrypt.md5(hash.slice(0, keyLenBytes));
    }
    return hash.slice(0, keyLenBytes);
  }
  function computeFileKeyRC4(password, O, P, idBytes, keyLenBytes, R, encryptMetadata){
    const padded = padPassword32(PDFEncrypt.encodePasswordLegacy(password));
    return computeFileKeyRC4FromPadded(padded, O, P, idBytes, keyLenBytes, R, encryptMetadata);
  }
  // Algorithm 7 (reversed): recover the padded user password from a candidate
  // owner password by undoing the RC4 passes used to originally produce /O.
  function recoverPaddedUserPasswordRC4(ownerPassword, O, keyLenBytes, R){
    const padded = padPassword32(PDFEncrypt.encodePasswordLegacy(ownerPassword));
    let hash = PDFEncrypt.md5(padded);
    if(R >= 3){ for(let i=0;i<50;i++) hash = PDFEncrypt.md5(hash); }
    const key = hash.slice(0, keyLenBytes);
    let result = O.slice();
    if(R === 2){
      result = new PDFEncrypt.RC4(key).process(result);
    } else {
      for(let i=19;i>=0;i--){
        const iterKey = new Uint8Array(key.length);
        for(let j=0;j<key.length;j++) iterKey[j] = key[j] ^ i;
        result = new PDFEncrypt.RC4(iterKey).process(result);
      }
    }
    return result;
  }
  function expectedUserKeyRC4(fileKey, idBytes, R){
    if(R === 2){
      return new PDFEncrypt.RC4(fileKey).process(PDFEncrypt.concat(PAD, idBytes));
    }
    const hash = PDFEncrypt.md5(PDFEncrypt.concat(PAD, idBytes));
    let result = new PDFEncrypt.RC4(fileKey).process(hash);
    for(let i=1;i<=19;i++){
      const key = new Uint8Array(fileKey.length);
      for(let j=0;j<fileKey.length;j++) key[j] = fileKey[j] ^ i;
      result = new PDFEncrypt.RC4(key).process(result);
    }
    return result;
  }
  function perObjectKeyRC4(fileKey, objNum, genNum){
    const extra = Uint8Array.from([objNum&0xff,(objNum>>8)&0xff,(objNum>>16)&0xff, genNum&0xff, (genNum>>8)&0xff]);
    const hash = PDFEncrypt.md5(PDFEncrypt.concat(fileKey, extra));
    return hash.slice(0, Math.min(fileKey.length+5, 16));
  }
  function decryptRC4Bytes(key, data){ return new PDFEncrypt.RC4(key).process(data); }

  async function aes256UnwrapNoPad(keyBytes, cipherBytes){
    // cipherBytes is exactly 32 raw (unpadded) bytes. Web Crypto's AES-CBC decrypt
    // always strips PKCS7 padding from the last block, which would corrupt this
    // unpadded key material — so we append one extra block engineered (via the
    // encrypt-only primitive we have) to decrypt to a valid "remove 16 bytes"
    // padding block, then let Web Crypto strip exactly that fake block off.
    const lastBlock = cipherBytes.slice(16,32);
    const paddingBlock = new Uint8Array(16).fill(16);
    const xored = new Uint8Array(16);
    for(let i=0;i<16;i++) xored[i] = paddingBlock[i] ^ lastBlock[i];
    const fakeBlock = await PDFEncrypt.aes256EcbEncryptBlock(xored, keyBytes);
    const extended = PDFEncrypt.concat(cipherBytes, fakeBlock);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name:"AES-CBC", iv:new Uint8Array(16) }, cryptoKey, extended);
    return new Uint8Array(pt);
  }
  async function computeFileKeyAES256(password, U, UE, O, OE){
    const pwBytes = PDFEncrypt.encodePasswordAES256(password);
    const uCheck = await PDFEncrypt.computeHash2B(pwBytes, U.slice(32,40), new Uint8Array(0));
    if(bytesEqualN(uCheck, U.slice(0,32), 32)){
      const interKey = await PDFEncrypt.computeHash2B(pwBytes, U.slice(40,48), new Uint8Array(0));
      return await aes256UnwrapNoPad(interKey, UE);
    }
    const oCheck = await PDFEncrypt.computeHash2B(pwBytes, O.slice(32,40), U);
    if(bytesEqualN(oCheck, O.slice(0,32), 32)){
      const interKey = await PDFEncrypt.computeHash2B(pwBytes, O.slice(40,48), U);
      return await aes256UnwrapNoPad(interKey, OE);
    }
    return null;
  }
  async function decryptAES256Stream(fileKey, data){
    if(data.length < 16) return new Uint8Array(0);
    const iv = data.slice(0,16), ct = data.slice(16);
    if(ct.length === 0) return new Uint8Array(0);
    const cryptoKey = await crypto.subtle.importKey("raw", fileKey, "AES-CBC", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name:"AES-CBC", iv }, cryptoKey, ct);
    return new Uint8Array(pt);
  }

  function bytesToPDFStringValue(bytes){
    const out = new Array(bytes.length);
    for(let i=0;i<bytes.length;i++){
      const b = bytes[i];
      if(b===0x5c) out[i] = "\\\\";
      else if(b===0x28) out[i] = "\\(";
      else if(b===0x29) out[i] = "\\)";
      else if(b===0x0d) out[i] = "\\r";
      else if(b===0x0a) out[i] = "\\n";
      else out[i] = String.fromCharCode(b);
    }
    return out.join("");
  }
  function isSignatureDict(dict){
    const type = dict.get(PDFName.of("Type"));
    const typeName = type && typeof type.asString === "function" ? type.asString() : null;
    if(typeName === "/Sig" || typeName === "/DocTimeStamp") return true;
    if(typeName !== null) return false;
    const byteRange = dict.get(PDFName.of("ByteRange"));
    return byteRange instanceof PDFArray && byteRange.size() === 4 && dict.has(PDFName.of("Contents"));
  }
  function skipKey(keyName, isSigDict){
    if(keyName === "/Length" || keyName === "/Filter" || keyName === "/DecodeParms") return true;
    return isSigDict && keyName === "/Contents";
  }
  async function decryptStrings(obj, decryptFn, seen){
    if(!obj || seen.has(obj)) return;
    if(obj instanceof PDFString){
      seen.add(obj);
      obj.value = bytesToPDFStringValue(await decryptFn(obj.asBytes()));
    } else if(obj instanceof PDFHexString){
      seen.add(obj);
      obj.value = PDFEncrypt.bytesToHex(await decryptFn(obj.asBytes()));
    } else if(obj instanceof PDFDict){
      seen.add(obj);
      const isSig = isSignatureDict(obj);
      for(const [key, value] of obj.entries()){
        if(!skipKey(key.asString(), isSig)) await decryptStrings(value, decryptFn, seen);
      }
    } else if(obj instanceof PDFArray){
      seen.add(obj);
      for(const el of obj.asArray()) await decryptStrings(el, decryptFn, seen);
    }
  }

  wireDrop(drop, input, async (files)=>{
    const file = files[0];
    fileName = file.name.replace(/\.pdf$/i,"");
    buffer = await readFileAsArrayBuffer(file);
    filenameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    body.style.display = "block";
    result.classList.remove("show");
    outputBlob = null; encInfo = null;
    passwordInput.value = "";
    runBtn.disabled = true;
    setStatus(status, "กำลังตรวจสอบไฟล์...", "loading");
    try{
      const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true, updateMetadata:false });
      const trailer = doc.context.trailerInfo;
      if(!trailer.Encrypt){
        encInfo = { supported:false };
        setStatus(status, "ไฟล์นี้ไม่มีรหัสผ่าน/การเข้ารหัสอยู่แล้ว ไม่จำเป็นต้องลบ", "err");
        return;
      }
      const encDict = doc.context.lookup(trailer.Encrypt);
      const V = encDict.get(PDFName.of("V"))?.asNumber?.() ?? 0;
      const R = encDict.get(PDFName.of("R"))?.asNumber?.() ?? 0;
      if(V === 5 || R === 6){
        encInfo = { supported:true, algo:"AES256", V, R };
        setStatus(status, "ตรวจพบการเข้ารหัสแบบ AES-256 · ใส่รหัสผ่านแล้วกดปลดล็อกรหัสผ่านได้เลย", "ok");
        runBtn.disabled = false;
      } else if(V === 1 || V === 2){
        encInfo = { supported:true, algo:"RC4", V, R };
        setStatus(status, "ตรวจพบการเข้ารหัสแบบ RC4 · ใส่รหัสผ่านแล้วกดปลดล็อกรหัสผ่านได้เลย", "ok");
        runBtn.disabled = false;
      } else {
        encInfo = { supported:false, V, R };
        setStatus(status, "ไฟล์นี้เข้ารหัสด้วยรูปแบบที่ยังไม่รองรับ (เช่น AES-128/V4) ลองเปิดไฟล์ด้วยโปรแกรมอ่าน PDF ทั่วไปด้วยรหัสผ่านนี้ แล้วสั่ง \"พิมพ์เป็น PDF\" ซ้ำเพื่อได้ไฟล์ที่ไม่มีรหัสผ่านแทน", "err");
      }
    }catch(e){
      encInfo = { supported:false };
      setStatus(status, "ไม่สามารถอ่านไฟล์นี้ได้: " + e.message, "err");
    }
  });

  runBtn.onclick = async ()=>{
    if(!buffer || !encInfo || !encInfo.supported) return;
    const password = passwordInput.value || "";
    runBtn.disabled = true;
    setStatus(status, "กำลังปลดล็อก...", "loading");
    try{
      if(!window.PDFEncrypt){ throw new Error("โหลดไลบรารีเข้ารหัสไม่สำเร็จ ลองรีเฟรชหน้าเว็บ"); }
      const doc = await PDFDocument.load(buffer.slice(0), { ignoreEncryption:true, updateMetadata:false });
      const context = doc.context;
      const trailer = context.trailerInfo;
      const encryptRef = trailer.Encrypt;
      const encDict = context.lookup(encryptRef);
      const idArr = trailer.ID;
      let idBytes = new Uint8Array(0);
      const firstId = idArr instanceof PDFArray ? idArr.get(0) : (Array.isArray(idArr) && idArr.length>0 ? idArr[0] : undefined);
      if(firstId && typeof firstId.asBytes === "function") idBytes = firstId.asBytes();

      let fileKey = null;
      const seen = new WeakSet();

      if(encInfo.algo === "AES256"){
        const U = encDict.get(PDFName.of("U")).asBytes();
        const UE = encDict.get(PDFName.of("UE")).asBytes();
        const O = encDict.get(PDFName.of("O")).asBytes();
        const OE = encDict.get(PDFName.of("OE")).asBytes();
        fileKey = await computeFileKeyAES256(password, U, UE, O, OE);
        if(!fileKey) throw new Error("WRONG_PASSWORD");
      } else {
        const O = encDict.get(PDFName.of("O")).asBytes();
        const P = encDict.get(PDFName.of("P")).asNumber();
        const R = encInfo.R;
        const lengthBits = encDict.get(PDFName.of("Length"))?.asNumber?.() ?? 40;
        const keyLenBytes = Math.max(5, Math.min(16, Math.round(lengthBits/8)));
        const emObj = encDict.get(PDFName.of("EncryptMetadata"));
        const encryptMetadata = emObj ? emObj.asBoolean?.() !== false : true;
        const U = encDict.get(PDFName.of("U")).asBytes();
        const compareLen = R === 2 ? 32 : 16;

        fileKey = computeFileKeyRC4(password, O, P, idBytes, keyLenBytes, R, encryptMetadata);
        let expected = expectedUserKeyRC4(fileKey, idBytes, R);
        if(!bytesEqualN(expected, U, compareLen)){
          const recoveredPadded = recoverPaddedUserPasswordRC4(password, O, keyLenBytes, R);
          fileKey = computeFileKeyRC4FromPadded(recoveredPadded, O, P, idBytes, keyLenBytes, R, encryptMetadata);
          expected = expectedUserKeyRC4(fileKey, idBytes, R);
          if(!bytesEqualN(expected, U, compareLen)) throw new Error("WRONG_PASSWORD");
        }
      }

      const indirectObjects = context.enumerateIndirectObjects();
      for(const [ref, obj] of indirectObjects){
        if(ref.objectNumber === encryptRef.objectNumber && ref.generationNumber === encryptRef.generationNumber) continue;
        if(obj instanceof PDFRawStream && obj.dict){
          const type = obj.dict.get(PDFName.of("Type"));
          if(type){
            const typeName = type.toString();
            if(typeName === "/XRef" || typeName === "/Sig") continue;
          }
        }
        const objDecrypt = encInfo.algo === "AES256"
          ? (bytes)=> decryptAES256Stream(fileKey, bytes)
          : (bytes)=> decryptRC4Bytes(perObjectKeyRC4(fileKey, ref.objectNumber, ref.generationNumber || 0), bytes);

        if(obj instanceof PDFRawStream){
          obj.contents = await objDecrypt(obj.contents);
          if(obj.dict) await decryptStrings(obj.dict, objDecrypt, seen);
        } else {
          await decryptStrings(obj, objDecrypt, seen);
        }
      }

      delete trailer.Encrypt;
      const bytes = await doc.save({ useObjectStreams:false });
      outputBlob = new Blob([bytes], { type:"application/pdf" });
      result.querySelector(".stats").innerHTML = `ปลดล็อกสำเร็จ · <b>${fmtBytes(outputBlob.size)}</b>`;
      result.classList.add("show");
      setStatus(status, "ปลดล็อกรหัสผ่านสำเร็จ ไฟล์นี้เปิดได้โดยไม่ต้องใส่รหัสผ่านอีกต่อไป", "ok");
      passwordInput.value = ""; // clear the password from the input once it's no longer needed
    }catch(e){
      if(e.message === "WRONG_PASSWORD"){
        setStatus(status, "รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่", "err");
      } else {
        setStatus(status, "เกิดข้อผิดพลาด: " + e.message, "err");
      }
    }
    runBtn.disabled = false;
  };

  removeBtn.onclick = ()=>{
    buffer = null; outputBlob = null; encInfo = null;
    body.style.display = "none";
    input.value = "";
    passwordInput.value = "";
    result.classList.remove("show");
    setStatus(status, "", "");
  };
  downloadBtn.onclick = ()=>{ if(outputBlob) downloadBlob(outputBlob, `${fileName}_unlocked.pdf`); };
})();

