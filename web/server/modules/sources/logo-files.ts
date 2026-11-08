// The emblem files the site takes (design §9.1), apart from schemas.ts so pages can import them
// without bringing Zod into the browser's bundle. A page of cards shows a score of emblems a few
// dozen pixels across, so each is kept small enough for the page to stay light (design §14).
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
export const LOGO_MAX_BYTES = 16 * 1024;
