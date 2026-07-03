import { useCallback, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { AnimatePresence, motion } from "framer-motion";
import imageCompression from "browser-image-compression";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast, Toaster } from "sonner";
import { compressPdfToTarget } from "@/lib/pdfTargetCompress";

type Status = "queued" | "processing" | "done" | "error";
type OutFormat = "keep" | "webp" | "jpeg" | "png" | "pdf";
type Mode = "quality" | "target";
type SizeUnit = "KB" | "MB";

interface Item {
  id: string;
  file: File;
  status: Status;
  progress: number;
  outBlob?: Blob;
  outName?: string;
  outSize?: number;
  error?: string;
  note?: string;
}

const TARGET_PRESETS: { label: string; value: number; unit: SizeUnit }[] = [
  { label: "50 KB", value: 50, unit: "KB" },
  { label: "100 KB", value: 100, unit: "KB" },
  { label: "200 KB", value: 200, unit: "KB" },
  { label: "500 KB", value: 500, unit: "KB" },
  { label: "1 MB", value: 1, unit: "MB" },
  { label: "2 MB", value: 2, unit: "MB" },
];

const uid = () => Math.random().toString(36).slice(2, 10);

const formatBytes = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const mimeFromFormat: Record<Exclude<OutFormat, "keep" | "pdf">, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

function isImage(f: File) {
  return f.type.startsWith("image/");
}
function isPdf(f: File) {
  return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
}

function swapExt(name: string, ext: string) {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + "." + ext;
}

export function ShrinkItApp() {
  const [items, setItems] = useState<Item[]>([]);
  const [quality, setQuality] = useState(75);
  const [format, setFormat] = useState<OutFormat>("keep");
  const [mode, setMode] = useState<Mode>("quality");
  const [targetValue, setTargetValue] = useState(500);
  const [targetUnit, setTargetUnit] = useState<SizeUnit>("KB");
  const targetBytes = Math.max(1, Math.round(targetValue * (targetUnit === "MB" ? 1024 * 1024 : 1024)));
  const inputId = "shrinkit-upload";
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef<Map<string, (v: { buffer: ArrayBuffer; mime: string; ext: string } | { error: string }) => void>>(new Map());

  const getWorker = () => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL("../../workers/pdf-worker.ts", import.meta.url), { type: "module" });
      workerRef.current.onmessage = (e: MessageEvent) => {
        const data = e.data as { id: string; type: string; buffer?: ArrayBuffer; mime?: string; ext?: string; error?: string };
        const cb = pending.current.get(data.id);
        if (!cb) return;
        pending.current.delete(data.id);
        if (data.type === "done" && data.buffer && data.mime && data.ext) {
          cb({ buffer: data.buffer, mime: data.mime, ext: data.ext });
        } else {
          cb({ error: data.error ?? "Worker error" });
        }
      };
    }
    return workerRef.current;
  };

  const runWorker = (msg: { type: string; id: string; buffer?: ArrayBuffer; buffers?: ArrayBuffer[]; mimes?: string[] }, transfers: ArrayBuffer[]) =>
    new Promise<{ buffer: ArrayBuffer; mime: string; ext: string }>((resolve, reject) => {
      pending.current.set(msg.id, (r) => {
        if ("error" in r) reject(new Error(r.error));
        else resolve(r);
      });
      getWorker().postMessage(msg, transfers);
    });

  const processItem = useCallback(
    async (item: Item, q: number, fmt: OutFormat, m: Mode, targetB: number) => {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: "processing", progress: 5 } : i)));
      try {
        let outBlob: Blob;
        let outName: string;
        let note: string | undefined;

        if (isPdf(item.file) && m === "target") {
          // Target-size PDF compression: rasterize pages + re-encode, walking
          // a DPI/quality ladder until we're at/under the target.
          if (targetB >= item.file.size) {
            note = "Already under target size";
            outBlob = item.file;
          } else {
            const res = await compressPdfToTarget(item.file, targetB, (p) =>
              setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, progress: Math.max(5, p) } : i))),
            );
            outBlob = res.blob;
            if (!res.hitTarget) {
              note = `Smallest achievable: ${formatBytes(res.bytes)} (target not reachable without more quality loss)`;
            }
          }
          outName = swapExt(item.file.name, "pdf");
        } else if (isImage(item.file) && fmt !== "pdf") {
          const targetMime = fmt === "keep" ? item.file.type : mimeFromFormat[fmt];
          const compressed = await imageCompression(item.file, {
            maxSizeMB: m === "target" ? targetB / (1024 * 1024) : 20,
            useWebWorker: true,
            initialQuality: m === "target" ? 0.92 : q / 100,
            alwaysKeepResolution: m === "quality",
            fileType: targetMime,
            onProgress: (p) =>
              setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, progress: Math.max(5, p) } : i))),
          });
          if (m === "target" && compressed.size > targetB) {
            note = `Smallest achievable: ${formatBytes(compressed.size)} (further shrinking would be too lossy)`;
          }
          outBlob = compressed;
          const ext = targetMime.split("/")[1].replace("jpeg", "jpg");
          outName = swapExt(item.file.name, ext);
        } else if (isImage(item.file) && fmt === "pdf") {
          // convert to PNG or JPG first if not compatible
          let src = item.file;
          if (src.type !== "image/png" && src.type !== "image/jpeg") {
            src = await imageCompression(src, { maxSizeMB: 20, useWebWorker: true, fileType: "image/jpeg", initialQuality: q / 100 });
          }
          const buf = await src.arrayBuffer();
          const res = await runWorker(
            { type: "image-to-pdf", id: item.id, buffers: [buf], mimes: [src.type] },
            [buf],
          );
          outBlob = new Blob([res.buffer], { type: res.mime });
          outName = swapExt(item.file.name, "pdf");
          if (m === "target") note = "Target size doesn't apply to image → PDF conversion yet";
        } else if (isPdf(item.file)) {
          const buf = await item.file.arrayBuffer();
          const res = await runWorker({ type: "compress-pdf", id: item.id, buffer: buf }, [buf]);
          outBlob = new Blob([res.buffer], { type: res.mime });
          outName = swapExt(item.file.name, "pdf");
        } else {
          throw new Error("Unsupported file type");
        }

        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: "done", progress: 100, outBlob, outName, outSize: outBlob.size, note }
              : i,
          ),
        );

        // auto-download
        const url = URL.createObjectURL(outBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: "error", error: message } : i)));
        toast.error(`${item.file.name}: ${message}`);
      }
    },
    [],
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (!accepted.length) return;
      const newItems: Item[] = accepted.map((f) => ({ id: uid(), file: f, status: "queued", progress: 0 }));
      setItems((prev) => [...newItems, ...prev]);
      newItems.forEach((it) => {
        void processItem(it, quality, format, mode, targetBytes);
      });
    },
    [processItem, quality, format, mode, targetBytes],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: false,
    noKeyboard: true,
    accept: {
      "image/*": [],
      "application/pdf": [".pdf"],
    },
    onDropRejected: () => toast.error("Only images and PDFs are supported."),
  });

  const download = (item: Item) => {
    if (!item.outBlob || !item.outName) return;
    const url = URL.createObjectURL(item.outBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.outName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const clearAll = () => setItems([]);

  const stats = useMemo(() => {
    const done = items.filter((i) => i.status === "done");
    const original = done.reduce((s, i) => s + i.file.size, 0);
    const compressed = done.reduce((s, i) => s + (i.outSize ?? 0), 0);
    const saved = original - compressed;
    const pct = original ? Math.max(0, (saved / original) * 100) : 0;
    return { count: done.length, original, compressed, saved, pct };
  }, [items]);

  return (
    <div className="min-h-screen flex flex-col">
      <Toaster position="top-center" richColors />

      <header className="w-full">
        <div className="mx-auto max-w-6xl px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground grid place-items-center font-display font-bold">S</div>
            <span className="font-display text-lg font-semibold tracking-tight">ShrinkIt</span>
          </div>
          <div className="text-xs text-muted-foreground hidden sm:block">
            100% private · runs in your browser
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 pt-8 pb-6 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="text-4xl sm:text-5xl font-semibold tracking-tight"
          >
            Compress & convert, <span className="text-accent">instantly.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.4 }}
            className="mt-3 text-muted-foreground max-w-xl mx-auto"
          >
            Shrink images and PDFs in seconds. Convert PNG · JPG · WebP · PDF. Nothing ever leaves your device.
          </motion.p>
        </section>

        <section className="mx-auto max-w-6xl px-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            {/* Dropzone */}
            <div
              {...getRootProps()}
              className={`relative rounded-2xl border-2 border-dashed bg-surface transition-colors ${
                isDragActive ? "border-accent bg-accent/5" : "border-border hover:border-accent/60"
              }`}
              style={{ boxShadow: "var(--shadow-soft)" }}
            >
              <input {...getInputProps({ id: inputId })} />
              <div className="p-10 sm:p-14 text-center flex flex-col items-center gap-4">
                <motion.div
                  animate={isDragActive ? { scale: 1.05 } : { scale: 1 }}
                  className="h-14 w-14 rounded-2xl bg-accent/15 text-accent grid place-items-center"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M20 21H4"/></svg>
                </motion.div>
                <div>
                  <div className="font-display text-xl font-semibold">
                    {isDragActive ? "Drop to shrink" : "Drop files here"}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    or click to browse · images & PDFs · unlimited files
                  </div>
                </div>
                <Button asChild className="mt-2 rounded-full px-6">
                  <label htmlFor={inputId} onClick={(event) => event.stopPropagation()}>
                    Choose files
                  </label>
                </Button>
              </div>
            </div>

            {/* Options */}
            
