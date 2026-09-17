import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/lib/env";

/* ============================================================
 * Media storage abstraction — the application never talks to a
 * storage implementation directly. Providers: local disk today;
 * S3-compatible / Cloudinary later, without touching call sites.
 * Binaries are NEVER stored in the database; only metadata rows.
 * ============================================================ */

export interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Extension point: providers that can serve direct public URLs. */
  publicUrl?(key: string): string;
}

class LocalDiskProvider implements StorageProvider {
  constructor(private root: string) {}
  private resolve(key: string): string {
    const abs = path.resolve(this.root, key);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error("Invalid storage key (path traversal)");
    }
    return abs;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

class SupabaseStorageProvider implements StorageProvider {
  private readonly base: string;
  private readonly bucket: string;
  private readonly key: string;

  constructor(url: string, serviceRoleKey: string, bucket: string) {
    this.base = url.replace(/\/$/, "");
    this.key = serviceRoleKey;
    this.bucket = bucket;
  }

  private objectUrl(key: string): string {
    return `${this.base}/storage/v1/object/${encodeURIComponent(this.bucket)}/${key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      apikey: this.key,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), {
      method: "POST",
      headers: { ...this.headers(contentType), "x-upsert": "true" },
      body,
    });
    if (!res.ok) throw new Error(`Supabase Storage upload failed (${res.status})`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await fetch(this.objectUrl(key), {
      method: "GET",
      headers: this.headers(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Supabase Storage download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(`${this.base}/storage/v1/object/${encodeURIComponent(this.bucket)}`, {
      method: "DELETE",
      headers: { ...this.headers("application/json"), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Supabase Storage delete failed (${res.status})`);
  }
}

class NotImplementedProvider implements StorageProvider {
  async put(): Promise<void> {
    throw new Error("s3 storage provider is not configured in this environment");
  }
  async get(): Promise<Buffer | null> {
    throw new Error("s3 storage provider is not configured in this environment");
  }
  async delete(): Promise<void> {
    throw new Error("s3 storage provider is not configured in this environment");
  }
}

let provider: StorageProvider | null = null;

export function storage(): StorageProvider {
  if (provider) return provider;
  const config = env();
  if (config.MEDIA_PROVIDER === "supabase") {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("MEDIA_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    provider = new SupabaseStorageProvider(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      config.SUPABASE_STORAGE_BUCKET,
    );
  } else {
    provider = new LocalDiskProvider(path.resolve(process.cwd(), config.MEDIA_ROOT));
  }
  return provider;
}

/** Build a collision-resistant storage key. */
export function makeStorageKey(prefix: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}/${stamp}-${crypto.randomBytes(6).toString("hex")}${ext}`;
}

/* ---------------- image sniffing (magic bytes, not just MIME claims) ---------------- */

export type SniffedImage = { mime: string; width: number | null; height: number | null };

export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length > 24) {
    // PNG
    if (buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      return { mime: "image/jpeg", width: null, height: null };
    }
    // WebP: RIFF....WEBP
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      return { mime: "image/webp", width: null, height: null };
    }
    // SVG rejected on purpose: admin-uploaded SVG can smuggle script content.
  }
  return null;
}

/* ---------------- document sniffing (Phase 5) ----------------
 * Applicant documents are untrusted uploads from outside the organisation.
 * The declared MIME type and the filename extension are both advisory; what
 * counts is the file signature, checked against the small allow-list below.
 * Anything else — SVG, HTML scripts, executables, archives, "pdf.docx.pdf"
 * trickery — is refused before a byte is written to disk. */

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024; // absolute ceiling per file

export type SniffedDocument = { mime: string; extension: string };

const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  // PDF: magic header only. Content is never parsed or executed here; it is
  // stored as an opaque blob and served back with a restrictive disposition.
  {
    mime: "application/pdf",
    ext: "pdf",
    test: (b) => b.length > 1024 && b.subarray(0, 5).toString("latin1") === "%PDF-",
  },
  {
    mime: "image/png",
    ext: "png",
    test: (b) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

/** Returns the detected type, or null when the bytes are not an accepted
 *  document format — regardless of what the client claimed. */
export function sniffDocument(buf: Buffer): SniffedDocument | null {
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buf)) return { mime: sig.mime, extension: sig.ext };
    } catch {
      /* a throwing signature must never let a file through */
    }
  }
  return null;
}

/** Filename hygiene: no path components, no control characters, bounded length. */
export function safeFilename(name: string, fallback = "document"): string {
  const base = String(name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9 .()_\-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 140);
}

/** sha256 of the stored bytes — de-duplication and integrity evidence. */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
