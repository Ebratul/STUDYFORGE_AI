import type { CloudinarySdk } from "../../src/modules/documents/storage/cloudinary.js";

export type Stored = { data: Buffer; resourceType: string; type: string };
type Fault = { http_code?: number; message?: string; name?: string; code?: string };

/**
 * In-memory stand-in for the Cloudinary SDK + its download endpoint. No network, no credentials: it records exactly what the
 * adapter asked for (resource type, delivery type, public id) so tests can assert the objects are raw + authenticated.
 */
export class FakeCloudinary {
  store = new Map<string, Stored>();
  calls: { op: string; publicId?: string; options: Record<string, unknown> }[] = [];
  /** Next call of an op fails with this SDK-style error ({message, http_code}). */
  faults = new Map<string, Fault[]>();
  /** Make uploads land with a different delivery type (simulates a misconfigured account/preset). */
  forceUploadType: string | null = null;
  /** HTTP status the download endpoint returns instead of the file (e.g. 404, 429, 503). */
  downloadStatus: number | null = null;

  fail(op: "upload" | "destroy" | "ping" | "download", ...faults: Fault[]) {
    this.faults.set(op, [...(this.faults.get(op) ?? []), ...faults]);
  }
  private takeFault(op: string) {
    return this.faults.get(op)?.shift();
  }

  sdk: CloudinarySdk = {
    uploader: {
      upload_stream: (options, callback) => {
        this.calls.push({ op: "upload", publicId: options.public_id as string, options });
        return {
          end: (data: Buffer) => {
            queueMicrotask(() => {
              const fault = this.takeFault("upload");
              if (fault) return callback(fault);
              const publicId = options.public_id as string;
              const type = this.forceUploadType ?? (options.type as string);
              this.store.set(publicId, { data: Buffer.from(data), resourceType: options.resource_type as string, type });
              callback(null, { public_id: publicId, resource_type: options.resource_type as string, type, bytes: data.byteLength });
            });
          },
        };
      },
      destroy: async (publicId, options) => {
        this.calls.push({ op: "destroy", publicId, options });
        const fault = this.takeFault("destroy");
        if (fault) throw fault;
        const found = this.store.get(publicId);
        if (found && found.resourceType === options.resource_type && found.type === options.type) {
          this.store.delete(publicId);
          return { result: "ok" };
        }
        return { result: "not found" };
      },
    },
    api: {
      ping: async (options) => {
        this.calls.push({ op: "ping", options });
        const fault = this.takeFault("ping");
        if (fault) throw fault;
        return { status: "OK" };
      },
    },
    utils: {
      private_download_url: (publicId, _format, options) => {
        this.calls.push({ op: "signed_url", publicId, options });
        return `https://api.cloudinary.test/v1_1/${String(options.cloud_name)}/${String(options.resource_type)}/download?public_id=${encodeURIComponent(publicId)}&type=${String(options.type)}&signature=fake`;
      },
    },
  };

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const publicId = url.searchParams.get("public_id")!;
    this.calls.push({ op: "download", publicId, options: { host: url.host } });
    const fault = this.takeFault("download");
    if (fault) throw Object.assign(new Error(fault.message ?? "network"), { name: fault.name ?? "Error", code: fault.code });
    if (this.downloadStatus) return new Response("error body that must never be surfaced", { status: this.downloadStatus });
    const found = this.store.get(publicId);
    if (!found || found.type !== url.searchParams.get("type")) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(found.data), { status: 200 });
  };
}

export const CLOUDINARY_TEST_SECRET = "test-api-secret-must-never-leak";

export function fakeConfig(over: Partial<{ folder: string; maxFileBytes: number; maxReadBytes: number }> = {}) {
  return { cloudName: "demo-cloud", apiKey: "123456789012345", apiSecret: CLOUDINARY_TEST_SECRET, folder: "studyforge/documents", maxReadBytes: 25 * 1024 * 1024, ...over };
}
