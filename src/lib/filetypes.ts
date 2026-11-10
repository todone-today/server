// What can be uploaded, how big, and how to tell a file really is what it claims (its first bytes). Images are capped
// at 5 MB: the app shrinks photos before uploading (clients lib/files.ts shrink), so that is plenty.
export const MB = 1024 * 1024;
type Kind = { max: number; inline: boolean; magic: (b: Uint8Array) => boolean };

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const ftyp = (b: Uint8Array, brands: string[]) => ascii(b, 4, "ftyp") && brands.some((x) => ascii(b, 8, x));

export const TYPES: Record<string, Kind> = {
  "image/jpeg": { max: 5 * MB, inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { max: 5 * MB, inline: true, magic: (b) => ascii(b, 1, "PNG") && b[0] === 0x89 },
  "image/gif": { max: 5 * MB, inline: true, magic: (b) => ascii(b, 0, "GIF8") },
  "image/webp": { max: 5 * MB, inline: true, magic: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  "image/heic": { max: 5 * MB, inline: false, magic: (b) => ftyp(b, ["heic", "heix", "mif1", "msf1", "heis"]) },
  "video/mp4": { max: 50 * MB, inline: true, magic: (b) => ascii(b, 4, "ftyp") },
  "video/quicktime": {
    max: 50 * MB,
    inline: true,
    magic: (b) => ascii(b, 4, "ftyp") || ascii(b, 4, "moov") || ascii(b, 4, "wide"),
  },
  "video/webm": {
    max: 50 * MB,
    inline: true,
    magic: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
  "application/pdf": { max: 10 * MB, inline: false, magic: (b) => ascii(b, 0, "%PDF") },
  "text/plain": { max: 10 * MB, inline: false, magic: (b) => !b.includes(0) },
};

// Storage caps.
export const SHARE_CAP = 200 * MB;
export const WORKSPACE_CAP = 1024 * MB;
// Encrypted files carry a 12-byte IV and a 16-byte tag on top of the original.
export const ENC_OVERHEAD = 28;

export function allowed(type: string, size: number) {
  const k = TYPES[type];
  if (!k) return "That kind of file isn't supported. Images, videos, PDFs and text files work.";
  if (!Number.isInteger(size) || size <= 0 || size > k.max)
    return `That file is too big: ${type.startsWith("video/") ? "videos" : "files like this"} can be up to ${k.max / MB} MB.`;
  return null;
}
